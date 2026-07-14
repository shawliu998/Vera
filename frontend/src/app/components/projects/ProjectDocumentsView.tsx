"use client";

// Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/projects/ProjectDocumentsView.tsx
import {
    type DragEvent,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    AlertCircle,
    ChevronDown,
    ChevronRight,
    Download,
    FileUp,
    Folder,
    FolderOpen,
    FolderPlus,
    Loader2,
    Pencil,
    RefreshCw,
    Trash2,
    Upload,
    X,
} from "lucide-react";
import { AddProjectDocsModal } from "@/app/components/shared/AddProjectDocsModal";
import { ConfirmPopup } from "@/app/components/shared/ConfirmPopup";
import { VersionChip } from "@/app/components/shared/VersionChip";
import { invalidateDirectoryCache } from "@/app/components/shared/useDirectoryData";
import { useI18n } from "@/app/i18n";
import { SUPPORTED_DOCUMENT_ACCEPT } from "@/app/lib/documentUploadValidation";
import {
    createVeraProjectFolder,
    deleteVeraDocument,
    deleteVeraProjectFolder,
    downloadVeraCapability,
    getVeraDocumentDownloadCapability,
    listVeraDocumentVersions,
    moveVeraProjectDocument,
    renameVeraProjectDocument,
    retryVeraDocumentParse,
    updateVeraProjectFolder,
    uploadVeraDocument,
    uploadVeraDocumentVersion,
} from "@/app/lib/veraApi";
import type {
    VeraDocumentVersionWire,
    VeraDocumentWire,
    VeraFolderWire,
} from "@/app/lib/veraWireTypes";
import { DocumentSidePanel } from "./DocumentSidePanel";
import {
    DOC_NAME_COL_W,
    DocIcon,
    DocVersionHistory,
    treeNameCellStyle,
} from "./ProjectPageParts";
import {
    ProjectSectionToolbar,
    useProjectWorkspace,
} from "./ProjectWorkspace";

interface Props {
    projectId: string;
}

type VersionState = {
    currentVersionId: string | null;
    versions: VeraDocumentVersionWire[];
};

type FolderDeleteImpact = {
    folder: VeraFolderWire;
    folderIds: string[];
    documentIds: string[];
};

const VERA_DOCUMENT_DRAG = "application/vera-document";
const VERA_FOLDER_DRAG = "application/vera-folder";

export function ProjectDocumentsView({ projectId }: Props) {
    const {
        project,
        documents,
        setDocuments,
        folders,
        setFolders,
        projectLoading,
        projectError,
        refreshProject,
        search,
    } = useProjectWorkspace();
    const { t, formatDate, formatFileSize, formatNumber, errorMessage } =
        useI18n();
    const [addDocumentsOpen, setAddDocumentsOpen] = useState(false);
    const [viewingDocumentId, setViewingDocumentId] = useState<string | null>(
        null,
    );
    const [viewingVersionId, setViewingVersionId] = useState<string | null>(
        null,
    );
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
        new Set(),
    );
    const [expandedVersionDocuments, setExpandedVersionDocuments] = useState<
        Set<string>
    >(new Set());
    const [versionsByDocument, setVersionsByDocument] = useState<
        Map<string, VersionState>
    >(new Map());
    const [loadingVersions, setLoadingVersions] = useState<Set<string>>(
        new Set(),
    );
    const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
    const [actionError, setActionError] = useState<string | null>(null);
    const [uploadingFilenames, setUploadingFilenames] = useState<string[]>([]);
    const [dragTarget, setDragTarget] = useState<string | "root" | null>(null);
    const [creatingFolderIn, setCreatingFolderIn] = useState<
        string | null | undefined
    >(undefined);
    const [folderNameDraft, setFolderNameDraft] = useState("");
    const [renamingFolderId, setRenamingFolderId] = useState<string | null>(
        null,
    );
    const [renamingDocumentId, setRenamingDocumentId] = useState<string | null>(
        null,
    );
    const [renameDraft, setRenameDraft] = useState("");
    const [pendingDeleteDocument, setPendingDeleteDocument] =
        useState<VeraDocumentWire | null>(null);
    const [pendingDeleteFolder, setPendingDeleteFolder] =
        useState<FolderDeleteImpact | null>(null);
    const rootUploadRef = useRef<HTMLInputElement>(null);
    const versionUploadRef = useRef<HTMLInputElement>(null);
    const versionUploadTargetRef = useRef<string | null>(null);
    const versionControllersRef = useRef<Map<string, AbortController>>(
        new Map(),
    );
    const busyKeysRef = useRef<Set<string>>(new Set());

    useEffect(
        () => () => {
            versionControllersRef.current.forEach((controller) =>
                controller.abort(),
            );
            versionControllersRef.current.clear();
        },
        [],
    );

    const viewingDocument = viewingDocumentId
        ? documents.find((document) => document.id === viewingDocumentId) ?? null
        : null;

    const replaceDocument = useCallback(
        (updated: VeraDocumentWire) => {
            setDocuments((current) => {
                const exists = current.some((item) => item.id === updated.id);
                return exists
                    ? current.map((item) =>
                          item.id === updated.id ? updated : item,
                      )
                    : [updated, ...current];
            });
        },
        [setDocuments],
    );

    const perform = useCallback(
        async (key: string, operation: () => Promise<void>) => {
            if (busyKeysRef.current.has(key)) return;
            busyKeysRef.current.add(key);
            setBusyKeys((current) => new Set([...current, key]));
            setActionError(null);
            try {
                await operation();
            } catch (error) {
                setActionError(errorMessage(error as Error));
            } finally {
                busyKeysRef.current.delete(key);
                setBusyKeys((current) => {
                    const next = new Set(current);
                    next.delete(key);
                    return next;
                });
            }
        },
        [errorMessage],
    );

    const loadVersions = useCallback(
        async (documentId: string, force = false) => {
            if (!force && versionsByDocument.has(documentId)) return;
            versionControllersRef.current.get(documentId)?.abort();
            const controller = new AbortController();
            versionControllersRef.current.set(documentId, controller);
            setLoadingVersions((current) =>
                new Set([...current, documentId]),
            );
            try {
                const loaded = await listVeraDocumentVersions(
                    documentId,
                    controller.signal,
                );
                if (controller.signal.aborted) return;
                setVersionsByDocument((current) => {
                    const next = new Map(current);
                    next.set(documentId, {
                        currentVersionId: loaded.current_version_id,
                        versions: loaded.versions,
                    });
                    return next;
                });
            } catch (error) {
                if (!controller.signal.aborted) {
                    setActionError(errorMessage(error as Error));
                }
            } finally {
                if (!controller.signal.aborted) {
                    setLoadingVersions((current) => {
                        const next = new Set(current);
                        next.delete(documentId);
                        return next;
                    });
                    versionControllersRef.current.delete(documentId);
                }
            }
        },
        [errorMessage, versionsByDocument],
    );

    const downloadDocument = useCallback(
        async (documentId: string, versionId?: string) => {
            const capability = await getVeraDocumentDownloadCapability(
                documentId,
                versionId,
            );
            const response = await downloadVeraCapability(capability);
            const url = URL.createObjectURL(response.blob);
            try {
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download =
                    response.filename ?? capability.filename ?? "document";
                anchor.rel = "noopener";
                document.body.appendChild(anchor);
                anchor.click();
                anchor.remove();
            } finally {
                window.setTimeout(() => URL.revokeObjectURL(url), 0);
            }
        },
        [],
    );

    const uploadFiles = useCallback(
        async (files: File[], folderId: string | null) => {
            if (files.length === 0) return;
            setUploadingFilenames((current) => [
                ...current,
                ...files.map((file) => file.name),
            ]);
            setActionError(null);
            const settled = await Promise.allSettled(
                files.map((file) =>
                    uploadVeraDocument({ file, projectId, folderId }),
                ),
            );
            settled.forEach((result) => {
                if (result.status === "fulfilled") {
                    replaceDocument(result.value.document);
                }
            });
            const failure = settled.find(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected",
            );
            if (failure) setActionError(errorMessage(failure.reason as Error));
            setUploadingFilenames((current) => {
                const completed = new Set(files.map((file) => file.name));
                return current.filter((filename) => !completed.has(filename));
            });
            invalidateDirectoryCache();
        },
        [errorMessage, projectId, replaceDocument],
    );

    const uploadVersion = useCallback(
        async (documentId: string, file: File) => {
            const document = documents.find((item) => item.id === documentId);
            if (
                !document ||
                filenameExtension(document.filename) !==
                    filenameExtension(file.name)
            ) {
                throw { code: "VALIDATION_ERROR", status: 400 };
            }
            const result = await uploadVeraDocumentVersion(
                documentId,
                file,
                { projectId },
            );
            replaceDocument(result.document);
            await loadVersions(documentId, true);
            invalidateDirectoryCache();
        },
        [documents, loadVersions, projectId, replaceDocument],
    );

    const retryDocument = useCallback(
        async (documentId: string) => {
            await retryVeraDocumentParse(documentId, { projectId });
            setDocuments((current) =>
                current.map((document) =>
                    document.id === documentId
                        ? { ...document, status: "processing" }
                        : document,
                ),
            );
        },
        [projectId, setDocuments],
    );

    const renameDocument = useCallback(
        async (documentId: string, filename: string) => {
            const current = documents.find((item) => item.id === documentId);
            if (
                !current ||
                filenameExtension(current.filename) !==
                    filenameExtension(filename)
            ) {
                throw { code: "VALIDATION_ERROR", status: 400 };
            }
            const updated = await renameVeraProjectDocument(
                projectId,
                documentId,
                filename,
            );
            replaceDocument(updated);
            setRenamingDocumentId(null);
            invalidateDirectoryCache();
        },
        [documents, projectId, replaceDocument],
    );

    const moveDocument = useCallback(
        async (documentId: string, folderId: string | null) => {
            const updated = await moveVeraProjectDocument(
                projectId,
                documentId,
                folderId,
            );
            replaceDocument(updated);
        },
        [projectId, replaceDocument],
    );

    const removeDocument = useCallback(
        async (document: VeraDocumentWire) => {
            await deleteVeraDocument(document.id, { projectId });
            setDocuments((current) =>
                current.filter((item) => item.id !== document.id),
            );
            setVersionsByDocument((current) => {
                const next = new Map(current);
                next.delete(document.id);
                return next;
            });
            if (viewingDocumentId === document.id) {
                setViewingDocumentId(null);
                setViewingVersionId(null);
            }
            setPendingDeleteDocument(null);
            invalidateDirectoryCache();
        },
        [projectId, setDocuments, viewingDocumentId],
    );

    const createFolder = async (parentFolderId: string | null) => {
        const name = folderNameDraft.trim();
        if (!name) return;
        await perform(`folder-create:${parentFolderId ?? "root"}`, async () => {
            const created = await createVeraProjectFolder(projectId, {
                name,
                parent_folder_id: parentFolderId,
            });
            setFolders((current) => [...current, created]);
            setCreatingFolderIn(undefined);
            setFolderNameDraft("");
            if (parentFolderId) {
                setExpandedFolders(
                    (current) => new Set([...current, parentFolderId]),
                );
            }
        });
    };

    const renameFolder = async (folderId: string) => {
        const name = renameDraft.trim();
        if (!name) {
            setRenamingFolderId(null);
            return;
        }
        await perform(`folder-rename:${folderId}`, async () => {
            const updated = await updateVeraProjectFolder(
                projectId,
                folderId,
                { name },
            );
            setFolders((current) =>
                current.map((folder) =>
                    folder.id === folderId ? updated : folder,
                ),
            );
            setRenamingFolderId(null);
        });
    };

    const descendantFolderIds = useCallback(
        (folderId: string) => {
            const ids = new Set([folderId]);
            let changed = true;
            while (changed) {
                changed = false;
                folders.forEach((folder) => {
                    if (
                        folder.parent_folder_id &&
                        ids.has(folder.parent_folder_id) &&
                        !ids.has(folder.id)
                    ) {
                        ids.add(folder.id);
                        changed = true;
                    }
                });
            }
            return ids;
        },
        [folders],
    );

    const requestDeleteFolder = (folder: VeraFolderWire) => {
        const subtree = descendantFolderIds(folder.id);
        setPendingDeleteFolder({
            folder,
            folderIds: [...subtree],
            documentIds: documents
                .filter(
                    (document) =>
                        document.folder_id && subtree.has(document.folder_id),
                )
                .map((document) => document.id),
        });
    };

    const removeFolder = async (impact: FolderDeleteImpact) => {
        const folderIds = descendantFolderIds(impact.folder.id);
        const documentIds = new Set(
            documents
                .filter(
                    (document) =>
                        document.folder_id &&
                        folderIds.has(document.folder_id),
                )
                .map((document) => document.id),
        );
        await deleteVeraProjectFolder(projectId, impact.folder.id);
        setFolders((current) =>
            current.filter((item) => !folderIds.has(item.id)),
        );
        setDocuments((current) =>
            current.filter((item) => !documentIds.has(item.id)),
        );
        setVersionsByDocument((current) => {
            const next = new Map(current);
            documentIds.forEach((documentId) => next.delete(documentId));
            return next;
        });
        setExpandedVersionDocuments((current) => {
            const next = new Set(current);
            documentIds.forEach((documentId) => next.delete(documentId));
            return next;
        });
        setLoadingVersions((current) => {
            const next = new Set(current);
            documentIds.forEach((documentId) => next.delete(documentId));
            return next;
        });
        setExpandedFolders((current) => {
            const next = new Set(current);
            folderIds.forEach((folderId) => next.delete(folderId));
            return next;
        });
        documentIds.forEach((documentId) => {
            versionControllersRef.current.get(documentId)?.abort();
            versionControllersRef.current.delete(documentId);
        });
        if (viewingDocumentId && documentIds.has(viewingDocumentId)) {
            setViewingDocumentId(null);
            setViewingVersionId(null);
        }
        setPendingDeleteFolder(null);
        invalidateDirectoryCache();
    };

    const moveFolder = useCallback(
        async (folderId: string, parentFolderId: string | null) => {
            if (
                parentFolderId &&
                descendantFolderIds(folderId).has(parentFolderId)
            ) {
                setActionError(t("errors.validation"));
                return;
            }
            const updated = await updateVeraProjectFolder(projectId, folderId, {
                parent_folder_id: parentFolderId,
            });
            setFolders((current) =>
                current.map((folder) =>
                    folder.id === folderId ? updated : folder,
                ),
            );
        },
        [descendantFolderIds, projectId, setFolders, t],
    );

    const handleInternalDrop = async (
        event: DragEvent,
        targetFolderId: string | null,
    ) => {
        const documentId = event.dataTransfer.getData(VERA_DOCUMENT_DRAG);
        const folderId = event.dataTransfer.getData(VERA_FOLDER_DRAG);
        if (documentId) {
            await perform(`move:${documentId}`, () =>
                moveDocument(documentId, targetFolderId),
            );
        } else if (folderId) {
            await perform(`folder-move:${folderId}`, () =>
                moveFolder(folderId, targetFolderId),
            );
        }
    };

    const onDrop = (
        event: DragEvent,
        targetFolderId: string | null,
    ) => {
        event.preventDefault();
        event.stopPropagation();
        setDragTarget(null);
        if (
            event.dataTransfer.types.includes(VERA_DOCUMENT_DRAG) ||
            event.dataTransfer.types.includes(VERA_FOLDER_DRAG)
        ) {
            void handleInternalDrop(event, targetFolderId);
            return;
        }
        void uploadFiles(Array.from(event.dataTransfer.files), targetFolderId);
    };

    const toggleVersions = (documentId: string) => {
        const opening = !expandedVersionDocuments.has(documentId);
        setExpandedVersionDocuments((current) => {
            const next = new Set(current);
            if (next.has(documentId)) next.delete(documentId);
            else next.add(documentId);
            return next;
        });
        if (opening) void loadVersions(documentId);
    };

    const query = search.trim().toLocaleLowerCase();
    const filteredDocuments = useMemo(
        () =>
            query
                ? documents.filter((document) =>
                      document.filename.toLocaleLowerCase().includes(query),
                  )
                : documents,
        [documents, query],
    );

    const tableActions = (
        <div className="flex items-center gap-4">
            <button
                type="button"
                disabled={projectLoading}
                onClick={() => {
                    setCreatingFolderIn(null);
                    setFolderNameDraft("");
                }}
                className="flex items-center gap-1 text-xs font-medium text-gray-500 transition-colors hover:text-gray-700 disabled:text-gray-300"
            >
                <FolderPlus className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t("common.actions.create")}</span>
            </button>
            <button
                type="button"
                disabled={projectLoading}
                onClick={() => setAddDocumentsOpen(true)}
                className="flex items-center gap-1 text-xs font-medium text-gray-500 transition-colors hover:text-gray-700 disabled:text-gray-300"
            >
                <Upload className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t("documents.addToProject")}</span>
            </button>
        </div>
    );

    const renderFolderInput = (
        parentFolderId: string | null,
        depth: number,
    ) =>
        creatingFolderIn === parentFolderId ? (
            <div className="flex h-10 items-center pr-8">
                <div
                    className={`sticky left-0 z-[60] ${DOC_NAME_COL_W} flex items-center gap-3 self-stretch bg-[#fafbfc] py-2 pl-4 pr-2`}
                    style={treeNameCellStyle(depth)}
                >
                    <FolderPlus className="h-4 w-4 shrink-0 text-amber-500" />
                    <input
                        autoFocus
                        value={folderNameDraft}
                        placeholder={t("common.fields.name")}
                        onChange={(event) =>
                            setFolderNameDraft(event.target.value)
                        }
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                void createFolder(parentFolderId);
                            }
                            if (event.key === "Escape") {
                                setCreatingFolderIn(undefined);
                                setFolderNameDraft("");
                            }
                        }}
                        onBlur={() => {
                            if (folderNameDraft.trim()) {
                                void createFolder(parentFolderId);
                            }
                        }}
                        className="min-w-0 flex-1 border-b border-gray-300 bg-transparent text-sm text-gray-800 outline-none"
                    />
                </div>
            </div>
        ) : null;

    const renderDocumentRow = (document: VeraDocumentWire, depth: number) => {
        const versionsExpanded = expandedVersionDocuments.has(document.id);
        const versionNumber =
            document.active_version_number ??
            document.latest_version_number ??
            1;
        return (
            <div key={document.id}>
                <div
                    draggable
                    onDragStart={(event) => {
                        event.dataTransfer.setData(
                            VERA_DOCUMENT_DRAG,
                            document.id,
                        );
                        event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(event) => {
                        if (
                            event.dataTransfer.types.includes("Files") &&
                            !event.dataTransfer.types.includes(
                                VERA_DOCUMENT_DRAG,
                            ) &&
                            !event.dataTransfer.types.includes(VERA_FOLDER_DRAG)
                        ) {
                            event.preventDefault();
                            event.stopPropagation();
                            setDragTarget(`version:${document.id}`);
                        }
                    }}
                    onDragLeave={(event) => {
                        if (
                            !event.currentTarget.contains(
                                event.relatedTarget as Node,
                            )
                        ) {
                            setDragTarget(null);
                        }
                    }}
                    onDrop={(event) => {
                        if (
                            !event.dataTransfer.types.includes("Files") ||
                            event.dataTransfer.types.includes(
                                VERA_DOCUMENT_DRAG,
                            ) ||
                            event.dataTransfer.types.includes(VERA_FOLDER_DRAG)
                        ) {
                            return;
                        }
                        event.preventDefault();
                        event.stopPropagation();
                        setDragTarget(null);
                        const files = Array.from(event.dataTransfer.files);
                        if (files.length !== 1) {
                            setActionError(t("errors.validation"));
                            return;
                        }
                        void perform(`version:${document.id}`, () =>
                            uploadVersion(document.id, files[0]),
                        );
                    }}
                    className={`group flex h-11 items-center border-b border-gray-50 pr-8 text-sm transition-colors ${
                        dragTarget === `version:${document.id}`
                            ? "bg-blue-50 ring-1 ring-inset ring-blue-200"
                            : "hover:bg-gray-50"
                    }`}
                >
                    <div
                        className={`sticky left-0 z-[60] ${DOC_NAME_COL_W} flex min-w-0 items-center gap-3 self-stretch bg-[#fafbfc] py-2 pl-4 pr-2 group-hover:bg-gray-50`}
                        style={treeNameCellStyle(depth)}
                    >
                        <button
                            type="button"
                            onClick={() => toggleVersions(document.id)}
                            aria-expanded={versionsExpanded}
                            aria-label={t("documents.version", {
                                version: versionNumber,
                            })}
                            className="flex h-5 w-5 shrink-0 items-center justify-center text-gray-400 hover:text-gray-700"
                        >
                            {loadingVersions.has(document.id) ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : versionsExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                            )}
                        </button>
                        <DocIcon fileType={document.file_type} />
                        {renamingDocumentId === document.id ? (
                            <input
                                autoFocus
                                value={renameDraft}
                                onChange={(event) =>
                                    setRenameDraft(event.target.value)
                                }
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                        void perform(
                                            `rename:${document.id}`,
                                            () =>
                                                renameDocument(
                                                    document.id,
                                                    renameDraft.trim(),
                                                ),
                                        );
                                    }
                                    if (event.key === "Escape") {
                                        setRenamingDocumentId(null);
                                    }
                                }}
                                className="min-w-0 flex-1 border-b border-gray-300 bg-transparent text-sm text-gray-800 outline-none"
                            />
                        ) : (
                            <button
                                type="button"
                                onClick={() => {
                                    setViewingDocumentId(document.id);
                                    setViewingVersionId(null);
                                }}
                                className="min-w-0 flex-1 truncate text-left text-gray-700 hover:text-gray-950"
                            >
                                {document.filename}
                            </button>
                        )}
                        <VersionChip n={versionNumber} />
                    </div>
                    <div className="ml-auto w-24 shrink-0 truncate text-xs text-gray-400">
                        {typeof document.size_bytes === "number"
                            ? formatFileSize(document.size_bytes)
                            : "—"}
                    </div>
                    <div className="w-28 shrink-0 truncate text-xs text-gray-400">
                        {document.updated_at
                            ? formatDate(document.updated_at)
                            : "—"}
                    </div>
                    <div className="w-24 shrink-0">
                        <StatusPill status={document.status} />
                    </div>
                    <label className="w-32 shrink-0 px-1">
                        <span className="sr-only">
                            {t("documents.moveToFolder")}
                        </span>
                        <select
                            value={document.folder_id ?? ""}
                            disabled={busyKeys.has(`move:${document.id}`)}
                            onChange={(event) =>
                                void perform(`move:${document.id}`, () =>
                                    moveDocument(
                                        document.id,
                                        event.target.value || null,
                                    ),
                                )
                            }
                            className="w-full truncate rounded-md border border-transparent bg-transparent px-1 py-1 text-xs text-gray-400 outline-none hover:border-gray-200 focus:border-gray-300"
                        >
                            <option value="">{project?.name ?? t("projects.title")}</option>
                            {folders.map((folder) => (
                                <option key={folder.id} value={folder.id}>
                                    {folder.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <div className="flex w-36 shrink-0 items-center justify-end gap-1">
                        {document.status === "error" && (
                            <IconAction
                                label={t("common.actions.retry")}
                                icon={RefreshCw}
                                busy={busyKeys.has(`retry:${document.id}`)}
                                onClick={() =>
                                    void perform(`retry:${document.id}`, () =>
                                        retryDocument(document.id),
                                    )
                                }
                            />
                        )}
                        <IconAction
                            label={t("common.actions.download")}
                            icon={Download}
                            busy={busyKeys.has(`download:${document.id}`)}
                            onClick={() =>
                                void perform(`download:${document.id}`, () =>
                                    downloadDocument(document.id),
                                )
                            }
                        />
                        <IconAction
                            label={t("documents.newVersion")}
                            icon={FileUp}
                            busy={busyKeys.has(`version:${document.id}`)}
                            onClick={() => {
                                versionUploadTargetRef.current = document.id;
                                versionUploadRef.current?.click();
                            }}
                        />
                        <IconAction
                            label={t("common.actions.rename")}
                            icon={Pencil}
                            onClick={() => {
                                setRenamingDocumentId(document.id);
                                setRenameDraft(document.filename);
                            }}
                        />
                        <IconAction
                            label={t("common.actions.delete")}
                            icon={Trash2}
                            danger
                            onClick={() => setPendingDeleteDocument(document)}
                        />
                    </div>
                </div>
                {versionsExpanded && (
                    <DocVersionHistory
                        documentId={document.id}
                        currentVersionId={
                            versionsByDocument.get(document.id)
                                ?.currentVersionId ?? null
                        }
                        loading={loadingVersions.has(document.id)}
                        versions={
                            versionsByDocument.get(document.id)?.versions ?? []
                        }
                        depth={depth + 1}
                        onOpenVersion={(versionId) => {
                            setViewingDocumentId(document.id);
                            setViewingVersionId(versionId);
                        }}
                        onDownloadVersion={(documentId, versionId) =>
                            void perform(
                                `download:${documentId}:${versionId}`,
                                () => downloadDocument(documentId, versionId),
                            )
                        }
                    />
                )}
            </div>
        );
    };

    const renderLevel = (
        parentFolderId: string | null,
        depth: number,
    ): React.ReactNode => {
        const childFolders = folders
            .filter(
                (folder) => folder.parent_folder_id === parentFolderId,
            )
            .sort((a, b) => a.name.localeCompare(b.name));
        const childDocuments = documents.filter(
            (document) => (document.folder_id ?? null) === parentFolderId,
        );
        return (
            <>
                {renderFolderInput(parentFolderId, depth)}
                {childFolders.map((folder) => {
                    const expanded = expandedFolders.has(folder.id);
                    const excludedParents = descendantFolderIds(folder.id);
                    return (
                        <div key={folder.id}>
                            <div
                                draggable
                                onDragStart={(event) => {
                                    event.dataTransfer.setData(
                                        VERA_FOLDER_DRAG,
                                        folder.id,
                                    );
                                    event.dataTransfer.effectAllowed = "move";
                                }}
                                onDragOver={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setDragTarget(folder.id);
                                }}
                                onDragLeave={() => setDragTarget(null)}
                                onDrop={(event) => onDrop(event, folder.id)}
                                className={`group flex h-11 items-center border-b border-gray-50 pr-8 text-sm transition-colors ${
                                    dragTarget === folder.id
                                        ? "bg-blue-50 ring-1 ring-inset ring-blue-200"
                                        : "hover:bg-gray-50"
                                }`}
                            >
                                <div
                                    className={`sticky left-0 z-[60] ${DOC_NAME_COL_W} flex min-w-0 items-center gap-3 self-stretch bg-[#fafbfc] py-2 pl-4 pr-2 group-hover:bg-gray-50`}
                                    style={treeNameCellStyle(depth)}
                                >
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setExpandedFolders((current) => {
                                                const next = new Set(current);
                                                if (next.has(folder.id)) {
                                                    next.delete(folder.id);
                                                } else next.add(folder.id);
                                                return next;
                                            })
                                        }
                                        aria-expanded={expanded}
                                        className="flex h-5 w-5 shrink-0 items-center justify-center text-gray-400"
                                    >
                                        {expanded ? (
                                            <ChevronDown className="h-3.5 w-3.5" />
                                        ) : (
                                            <ChevronRight className="h-3.5 w-3.5" />
                                        )}
                                    </button>
                                    {expanded ? (
                                        <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
                                    ) : (
                                        <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                                    )}
                                    {renamingFolderId === folder.id ? (
                                        <input
                                            autoFocus
                                            value={renameDraft}
                                            onChange={(event) =>
                                                setRenameDraft(event.target.value)
                                            }
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter") {
                                                    void renameFolder(folder.id);
                                                }
                                                if (event.key === "Escape") {
                                                    setRenamingFolderId(null);
                                                }
                                            }}
                                            className="min-w-0 flex-1 border-b border-gray-300 bg-transparent text-sm text-gray-800 outline-none"
                                        />
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setExpandedFolders((current) =>
                                                    new Set([
                                                        ...current,
                                                        folder.id,
                                                    ]),
                                                )
                                            }
                                            className="min-w-0 flex-1 truncate text-left text-gray-700"
                                        >
                                            {folder.name}
                                        </button>
                                    )}
                                </div>
                                <div className="ml-auto flex w-64 shrink-0 items-center justify-end gap-1">
                                    <label className="w-32 shrink-0 px-1">
                                        <span className="sr-only">
                                            {t("common.actions.move")}
                                        </span>
                                        <select
                                            value={folder.parent_folder_id ?? ""}
                                            onChange={(event) =>
                                                void perform(
                                                    `folder-move:${folder.id}`,
                                                    () =>
                                                        moveFolder(
                                                            folder.id,
                                                            event.target.value ||
                                                                null,
                                                        ),
                                                )
                                            }
                                            className="w-full truncate rounded-md border border-transparent bg-transparent px-1 py-1 text-xs text-gray-400 outline-none hover:border-gray-200"
                                        >
                                            <option value="">
                                                {project?.name ?? t("projects.title")}
                                            </option>
                                            {folders
                                                .filter(
                                                    (candidate) =>
                                                        !excludedParents.has(
                                                            candidate.id,
                                                        ),
                                                )
                                                .map((candidate) => (
                                                    <option
                                                        key={candidate.id}
                                                        value={candidate.id}
                                                    >
                                                        {candidate.name}
                                                    </option>
                                                ))}
                                        </select>
                                    </label>
                                    <IconAction
                                        label={t("common.actions.create")}
                                        icon={FolderPlus}
                                        onClick={() => {
                                            setCreatingFolderIn(folder.id);
                                            setFolderNameDraft("");
                                            setExpandedFolders(
                                                (current) =>
                                                    new Set([
                                                        ...current,
                                                        folder.id,
                                                    ]),
                                            );
                                        }}
                                    />
                                    <IconAction
                                        label={t("common.actions.rename")}
                                        icon={Pencil}
                                        onClick={() => {
                                            setRenamingFolderId(folder.id);
                                            setRenameDraft(folder.name);
                                        }}
                                    />
                                    <IconAction
                                        label={t("common.actions.delete")}
                                        icon={Trash2}
                                        danger
                                        onClick={() =>
                                            requestDeleteFolder(folder)
                                        }
                                    />
                                </div>
                            </div>
                            {expanded && renderLevel(folder.id, depth + 1)}
                        </div>
                    );
                })}
                {childDocuments.map((document) =>
                    renderDocumentRow(document, depth),
                )}
            </>
        );
    };

    return (
        <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            <input
                ref={rootUploadRef}
                type="file"
                accept={SUPPORTED_DOCUMENT_ACCEPT}
                multiple
                className="hidden"
                onChange={(event) => {
                    void uploadFiles(
                        Array.from(event.target.files ?? []),
                        null,
                    );
                    event.target.value = "";
                }}
            />
            <input
                ref={versionUploadRef}
                type="file"
                accept={SUPPORTED_DOCUMENT_ACCEPT}
                className="hidden"
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    const documentId = versionUploadTargetRef.current;
                    event.target.value = "";
                    versionUploadTargetRef.current = null;
                    if (!file || !documentId) return;
                    void perform(`version:${documentId}`, () =>
                        uploadVersion(documentId, file),
                    );
                }}
            />

            <ProjectSectionToolbar actions={tableActions} />

            {actionError && (
                <div
                    role="alert"
                    className="flex items-center gap-2 border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700 md:px-10"
                >
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1">{actionError}</span>
                    <button
                        type="button"
                        onClick={() => setActionError(null)}
                        aria-label={t("common.actions.close")}
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>
            )}

            <div
                className={`w-full min-h-0 flex-1 overflow-auto ${
                    dragTarget === "root"
                        ? "ring-2 ring-inset ring-blue-400"
                        : ""
                }`}
                onDragOver={(event) => {
                    event.preventDefault();
                    setDragTarget("root");
                }}
                onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                        setDragTarget(null);
                    }
                }}
                onDrop={(event) => onDrop(event, null)}
            >
                <div className="flex min-h-full min-w-max flex-col">
                    <div className="sticky top-0 z-[70] flex h-8 shrink-0 select-none items-center border-b border-gray-200 bg-[#fafbfc] pr-8 text-xs font-medium text-gray-500">
                        <div
                            className={`sticky left-0 z-[80] ${DOC_NAME_COL_W} flex self-stretch items-center bg-[#fafbfc] pl-4 pr-2`}
                        >
                            {t("common.fields.name")}
                        </div>
                        <div className="ml-auto w-24 shrink-0" />
                        <div className="w-28 shrink-0">
                            {t("common.fields.updatedAt")}
                        </div>
                        <div className="w-24 shrink-0" />
                        <div className="w-32 shrink-0" />
                        <div className="w-36 shrink-0" />
                    </div>

                    {projectLoading ? (
                        <ProjectTableLoading />
                    ) : projectError ? (
                        <div className="flex min-h-52 flex-col items-center justify-center gap-3 p-8 text-sm text-red-600">
                            <p role="alert">{projectError}</p>
                            <button
                                type="button"
                                onClick={() => void refreshProject()}
                                className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                            >
                                {t("common.actions.retry")}
                            </button>
                        </div>
                    ) : query ? (
                        filteredDocuments.length > 0 ? (
                            filteredDocuments.map((document) =>
                                renderDocumentRow(document, 0),
                            )
                        ) : (
                            <EmptyDocuments onUpload={() => rootUploadRef.current?.click()} />
                        )
                    ) : documents.length === 0 && folders.length === 0 ? (
                        <EmptyDocuments onUpload={() => rootUploadRef.current?.click()} />
                    ) : (
                        <>
                            {renderLevel(null, 0)}
                            {uploadingFilenames.map((filename) => (
                                <div
                                    key={filename}
                                    className="flex h-11 items-center gap-3 px-4 text-sm text-gray-400"
                                >
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    <span className="truncate">{filename}</span>
                                    <span className="text-xs">
                                        {t("common.status.processing")}
                                    </span>
                                </div>
                            ))}
                        </>
                    )}
                    <div className="min-h-16 flex-1" />
                </div>
            </div>

            {project && (
                <AddProjectDocsModal
                    open={addDocumentsOpen}
                    onClose={() => setAddDocumentsOpen(false)}
                    onSelect={(added) => {
                        added.forEach(replaceDocument);
                        invalidateDirectoryCache();
                    }}
                    breadcrumb={[
                        t("projects.title"),
                        project.name,
                        t("documents.addToProject"),
                    ]}
                    projectId={projectId}
                />
            )}

            <DocumentSidePanel
                doc={viewingDocument}
                versionId={viewingVersionId}
                currentVersionId={
                    viewingDocument
                        ? (versionsByDocument.get(viewingDocument.id)
                              ?.currentVersionId ?? null)
                        : null
                }
                versions={
                    viewingDocument
                        ? (versionsByDocument.get(viewingDocument.id)?.versions ??
                          [])
                        : []
                }
                versionsLoading={
                    viewingDocument
                        ? loadingVersions.has(viewingDocument.id)
                        : false
                }
                onClose={() => {
                    setViewingDocumentId(null);
                    setViewingVersionId(null);
                }}
                onLoadVersions={(documentId) => loadVersions(documentId)}
                onSelectVersion={setViewingVersionId}
                onDownloadDocument={(documentId) =>
                    downloadDocument(documentId)
                }
                onDownloadVersion={(documentId, versionId) =>
                    downloadDocument(documentId, versionId)
                }
                onRenameDocument={renameDocument}
                onUploadNewVersion={uploadVersion}
                onRetry={retryDocument}
                onDelete={removeDocument}
            />

            <ConfirmPopup
                open={pendingDeleteDocument != null}
                title={t("documents.deleteConfirm.title")}
                message={
                    pendingDeleteDocument
                        ? t("documents.deleteConfirm.body", {
                              name: pendingDeleteDocument.filename,
                          })
                        : undefined
                }
                confirmLabel={t("documents.deleteConfirm.action")}
                confirmStatus={
                    pendingDeleteDocument &&
                    busyKeys.has(`delete:${pendingDeleteDocument.id}`)
                        ? "loading"
                        : "idle"
                }
                cancelLabel={t("common.actions.cancel")}
                cancelDisabled={
                    pendingDeleteDocument != null &&
                    busyKeys.has(`delete:${pendingDeleteDocument.id}`)
                }
                onCancel={() => {
                    if (
                        pendingDeleteDocument &&
                        busyKeys.has(`delete:${pendingDeleteDocument.id}`)
                    ) {
                        return;
                    }
                    setPendingDeleteDocument(null);
                }}
                onConfirm={() => {
                    const document = pendingDeleteDocument;
                    if (!document) return;
                    void perform(`delete:${document.id}`, () =>
                        removeDocument(document),
                    );
                }}
            />

            <ConfirmPopup
                open={pendingDeleteFolder != null}
                title={t("common.actions.delete")}
                message={
                    pendingDeleteFolder ? (
                        <div className="space-y-3">
                            <p className="font-medium text-gray-950">
                                {pendingDeleteFolder.folder.name}
                            </p>
                            <div className="grid grid-cols-3 gap-2 text-center">
                                <div
                                    className="rounded-lg bg-gray-50 px-2 py-2"
                                    aria-label={`${t("documents.moveToFolder")}: ${formatNumber(
                                        pendingDeleteFolder.folderIds.length,
                                    )}`}
                                >
                                    <Folder
                                        className="mx-auto h-4 w-4 text-amber-500"
                                        aria-hidden="true"
                                    />
                                    <span className="mt-1 block text-xs text-gray-700">
                                        {formatNumber(
                                            pendingDeleteFolder.folderIds.length,
                                        )}
                                    </span>
                                </div>
                                <div
                                    className="rounded-lg bg-gray-50 px-2 py-2"
                                    aria-label={`${t("common.actions.create")} · ${t(
                                        "documents.moveToFolder",
                                    )}: ${formatNumber(
                                        Math.max(
                                            0,
                                            pendingDeleteFolder.folderIds.length -
                                                1,
                                        ),
                                    )}`}
                                >
                                    <FolderPlus
                                        className="mx-auto h-4 w-4 text-amber-500"
                                        aria-hidden="true"
                                    />
                                    <span className="mt-1 block text-xs text-gray-700">
                                        {formatNumber(
                                            Math.max(
                                                0,
                                                pendingDeleteFolder.folderIds
                                                    .length - 1,
                                            ),
                                        )}
                                    </span>
                                </div>
                                <div
                                    className="rounded-lg bg-gray-50 px-2 py-2"
                                    aria-label={`${t("documents.title")}: ${formatNumber(
                                        pendingDeleteFolder.documentIds.length,
                                    )}`}
                                >
                                    <span
                                        className="flex justify-center"
                                        aria-hidden="true"
                                    >
                                        <DocIcon fileType={null} />
                                    </span>
                                    <span className="mt-1 block text-xs text-gray-700">
                                        {formatNumber(
                                            pendingDeleteFolder.documentIds
                                                .length,
                                        )}{" "}
                                        {t("documents.title")}
                                    </span>
                                </div>
                            </div>
                        </div>
                    ) : undefined
                }
                confirmLabel={t("common.actions.delete")}
                confirmStatus={
                    pendingDeleteFolder &&
                    busyKeys.has(
                        `folder-delete:${pendingDeleteFolder.folder.id}`,
                    )
                        ? "loading"
                        : "idle"
                }
                cancelLabel={t("common.actions.cancel")}
                cancelDisabled={
                    pendingDeleteFolder != null &&
                    busyKeys.has(
                        `folder-delete:${pendingDeleteFolder.folder.id}`,
                    )
                }
                onCancel={() => {
                    if (
                        pendingDeleteFolder &&
                        busyKeys.has(
                            `folder-delete:${pendingDeleteFolder.folder.id}`,
                        )
                    ) {
                        return;
                    }
                    setPendingDeleteFolder(null);
                }}
                onConfirm={() => {
                    const folder = pendingDeleteFolder;
                    if (!folder) return;
                    void perform(`folder-delete:${folder.folder.id}`, () =>
                        removeFolder(folder),
                    );
                }}
            />
        </div>
    );
}

function StatusPill({ status }: { status: VeraDocumentWire["status"] }) {
    const { t } = useI18n();
    const label =
        status === "ready"
            ? t("common.status.ready")
            : status === "error"
              ? t("common.status.failed")
              : t("common.status.processing");
    return (
        <span
            className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${
                status === "ready"
                    ? "bg-emerald-50 text-emerald-700"
                    : status === "error"
                      ? "bg-red-50 text-red-700"
                      : "bg-amber-50 text-amber-700"
            }`}
        >
            {label}
        </span>
    );
}

function IconAction({
    label,
    icon: Icon,
    busy = false,
    danger = false,
    onClick,
}: {
    label: string;
    icon: typeof Download;
    busy?: boolean;
    danger?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            title={label}
            aria-label={label}
            disabled={busy}
            onClick={onClick}
            className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-40 ${
                danger
                    ? "text-red-500 hover:bg-red-50 hover:text-red-700"
                    : "text-gray-400 hover:bg-gray-100 hover:text-gray-800"
            }`}
        >
            {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
                <Icon className="h-3.5 w-3.5" />
            )}
        </button>
    );
}

function ProjectTableLoading() {
    const { t } = useI18n();
    return (
        <div aria-label={t("common.status.loading")}>
            {[1, 2, 3, 4, 5].map((index) => (
                <div
                    key={index}
                    className="flex h-11 items-center border-b border-gray-50 pr-8"
                >
                    <div
                        className={`sticky left-0 z-[60] ${DOC_NAME_COL_W} flex items-center gap-4 bg-[#fafbfc] py-2 pl-4 pr-2`}
                    >
                        <div className="h-4 w-4 animate-pulse rounded bg-gray-100" />
                        <div
                            className="h-3 animate-pulse rounded bg-gray-100"
                            style={{ width: `${180 + index * 22}px` }}
                        />
                    </div>
                </div>
            ))}
        </div>
    );
}

function EmptyDocuments({ onUpload }: { onUpload: () => void }) {
    const { t } = useI18n();
    return (
        <div className="flex min-h-64 flex-1 items-center justify-center p-8 text-center">
            <div className="max-w-sm">
                <h2 className="text-sm font-medium text-gray-900">
                    {t("documents.empty.title")}
                </h2>
                <p className="mt-2 text-sm text-gray-500">
                    {t("documents.empty.body")}
                </p>
                <button
                    type="button"
                    onClick={onUpload}
                    className="mt-4 inline-flex items-center gap-2 rounded-full bg-gray-950 px-4 py-2 text-xs font-medium text-white hover:bg-gray-800"
                >
                    <Upload className="h-3.5 w-3.5" />
                    {t("documents.empty.action")}
                </button>
            </div>
        </div>
    );
}

function filenameExtension(filename: string) {
    const trimmed = filename.trim();
    const dotIndex = trimmed.lastIndexOf(".");
    if (dotIndex <= 0 || dotIndex === trimmed.length - 1) return null;
    return trimmed.slice(dotIndex).toLowerCase();
}
