"use client";

// Authenticated local adaptation of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/projects/DocumentSidePanel.tsx
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
    Download,
    FileUp,
    Loader2,
    Pencil,
    RefreshCw,
    Trash2,
    X,
} from "lucide-react";
import { ConfirmPopup } from "@/app/components/shared/ConfirmPopup";
import { fileTypeKind } from "@/app/components/shared/FileTypeIcon";
import { VersionChip } from "@/app/components/shared/VersionChip";
import { DocxView } from "@/app/components/shared/views/DocxView";
import { PdfView, ViewerError } from "@/app/components/shared/views/PdfView";
import { SpreadsheetView } from "@/app/components/shared/views/SpreadsheetView";
import { TextView } from "@/app/components/shared/views/TextView";
import { useI18n } from "@/app/i18n";
import { SUPPORTED_DOCUMENT_ACCEPT } from "@/app/lib/documentUploadValidation";
import type {
    VeraDocumentVersionWire,
    VeraDocumentWire,
} from "@/app/lib/veraWireTypes";

interface DocumentSidePanelProps {
    doc: VeraDocumentWire | null;
    versionId?: string | null;
    currentVersionId: string | null;
    versions: VeraDocumentVersionWire[];
    versionsLoading: boolean;
    onClose: () => void;
    onLoadVersions: (documentId: string) => Promise<void>;
    onSelectVersion: (versionId: string | null) => void;
    onDownloadDocument: (documentId: string) => Promise<void>;
    onDownloadVersion: (
        documentId: string,
        versionId: string,
    ) => Promise<void>;
    onRenameDocument: (
        documentId: string,
        filename: string,
    ) => Promise<void>;
    onUploadNewVersion: (documentId: string, file: File) => Promise<void>;
    onRetry: (documentId: string) => Promise<void>;
    onDelete: (document: VeraDocumentWire) => Promise<void>;
}

export function DocumentSidePanel({
    doc,
    versionId = null,
    currentVersionId,
    versions,
    versionsLoading,
    onClose,
    onLoadVersions,
    onSelectVersion,
    onDownloadDocument,
    onDownloadVersion,
    onRenameDocument,
    onUploadNewVersion,
    onRetry,
    onDelete,
}: DocumentSidePanelProps) {
    const { t, formatDate, formatFileSize, errorMessage } = useI18n();
    const [mounted, setMounted] = useState(false);
    const [mobilePane, setMobilePane] = useState<"document" | "details">(
        "document",
    );
    const [editingName, setEditingName] = useState(false);
    const [nameDraft, setNameDraft] = useState("");
    const [busyAction, setBusyAction] = useState<
        "download" | "upload" | "retry" | "rename" | "delete" | null
    >(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const busyActionRef = useRef<typeof busyAction>(null);
    const onLoadVersionsRef = useRef(onLoadVersions);
    const documentId = doc?.id ?? null;
    const documentFilename = doc?.filename ?? "";

    useEffect(() => setMounted(true), []);

    useEffect(() => {
        onLoadVersionsRef.current = onLoadVersions;
    }, [onLoadVersions]);

    useEffect(() => {
        if (!documentId) return;
        setActionError(null);
        setMobilePane("document");
        void onLoadVersionsRef.current(documentId);
        queueMicrotask(() => closeButtonRef.current?.focus());
    }, [documentId]);

    useEffect(() => {
        if (!documentFilename) return;
        setNameDraft(documentFilename);
        setEditingName(false);
    }, [documentFilename]);

    useEffect(() => {
        if (!doc) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape" && busyAction == null) onClose();
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [busyAction, doc, onClose]);

    if (!mounted || !doc) return null;

    const selectedVersion =
        versions.find((version) => version.id === versionId) ?? null;
    const selectedFilename = selectedVersion?.filename?.trim() || doc.filename;
    const selectedVersionNumber =
        selectedVersion?.version_number ?? doc.active_version_number ?? 1;
    const selectedFileType =
        selectedVersion?.file_type ?? doc.file_type ?? selectedFilename;
    const isCurrent = !versionId || versionId === currentVersionId;

    const run = async (
        action: NonNullable<typeof busyAction>,
        operation: () => Promise<void>,
    ) => {
        if (busyActionRef.current) return;
        busyActionRef.current = action;
        setBusyAction(action);
        setActionError(null);
        try {
            await operation();
        } catch (error) {
            setActionError(errorMessage(error as Error));
        } finally {
            busyActionRef.current = null;
            setBusyAction(null);
        }
    };

    const saveName = async () => {
        const next = nameDraft.trim();
        if (!next || next === doc.filename) {
            setNameDraft(doc.filename);
            setEditingName(false);
            return;
        }
        if (filenameExtension(next) !== filenameExtension(doc.filename)) {
            setActionError(t("errors.validation"));
            return;
        }
        await run("rename", async () => {
            await onRenameDocument(doc.id, next);
            setEditingName(false);
        });
    };

    const panel = (
        <div className="fixed inset-0 z-[180] flex justify-end bg-gray-900/10 backdrop-blur-[1px]">
            <section
                role="dialog"
                aria-modal="true"
                aria-label={t("documents.preview")}
                className="flex h-full w-full max-w-[1180px] flex-col border-l border-white/70 bg-[#fafbfc]/95 shadow-[-12px_0_40px_rgba(15,23,42,0.12)] backdrop-blur-2xl"
            >
                <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-gray-200 px-4 md:px-6">
                    <div className="min-w-0 flex-1">
                        {editingName ? (
                            <input
                                autoFocus
                                value={nameDraft}
                                onChange={(event) => setNameDraft(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                        event.preventDefault();
                                        void saveName();
                                    }
                                    if (event.key === "Escape") {
                                        setNameDraft(doc.filename);
                                        setEditingName(false);
                                    }
                                }}
                                onBlur={() => void saveName()}
                                className="w-full border-b border-gray-300 bg-transparent text-sm font-medium text-gray-900 outline-none focus:border-gray-600"
                            />
                        ) : (
                            <button
                                type="button"
                                onClick={() => isCurrent && setEditingName(true)}
                                disabled={!isCurrent || busyAction != null}
                                className="flex max-w-full items-center gap-2 text-left text-sm font-medium text-gray-900 disabled:cursor-default"
                            >
                                <span className="truncate">{selectedFilename}</span>
                                {isCurrent && (
                                    <Pencil className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                                )}
                            </button>
                        )}
                    </div>
                    <div className="flex rounded-lg bg-gray-100 p-0.5 md:hidden">
                        {(["document", "details"] as const).map((pane) => (
                            <button
                                key={pane}
                                type="button"
                                onClick={() => setMobilePane(pane)}
                                className={`rounded-md px-2 py-1 text-xs ${
                                    mobilePane === pane
                                        ? "bg-white text-gray-900 shadow-sm"
                                        : "text-gray-500"
                                }`}
                            >
                                {pane === "document"
                                    ? t("documents.title")
                                    : t("common.actions.open")}
                            </button>
                        ))}
                    </div>
                    <button
                        ref={closeButtonRef}
                        type="button"
                        onClick={onClose}
                        aria-label={t("common.actions.close")}
                        className="rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </header>

                {actionError && (
                    <div
                        role="alert"
                        className="mx-4 mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 md:mx-6"
                    >
                        {actionError}
                    </div>
                )}

                <div className="flex min-h-0 flex-1">
                    <div
                        className={`min-w-0 flex-1 p-3 md:block md:p-5 ${
                            mobilePane === "document" ? "block" : "hidden"
                        }`}
                    >
                        <DocumentPreview
                            document={doc}
                            versionId={versionId}
                            filename={selectedFilename}
                            fileType={selectedFileType}
                        />
                    </div>

                    <aside
                        className={`w-full shrink-0 overflow-y-auto border-l border-gray-200 bg-white/70 p-4 md:block md:w-[340px] ${
                            mobilePane === "details" ? "block" : "hidden"
                        }`}
                    >
                        <div className="flex flex-wrap gap-2">
                            <ActionButton
                                label={t("common.actions.download")}
                                icon={Download}
                                busy={busyAction === "download"}
                                disabled={busyAction != null}
                                onClick={() =>
                                    void run("download", () =>
                                        versionId
                                            ? onDownloadVersion(doc.id, versionId)
                                            : onDownloadDocument(doc.id),
                                    )
                                }
                            />
                            <ActionButton
                                label={t("documents.newVersion")}
                                icon={FileUp}
                                busy={busyAction === "upload"}
                                disabled={busyAction != null}
                                onClick={() => fileInputRef.current?.click()}
                            />
                            {doc.status === "error" && (
                                <ActionButton
                                    label={t("common.actions.retry")}
                                    icon={RefreshCw}
                                    busy={busyAction === "retry"}
                                    disabled={busyAction != null}
                                    onClick={() =>
                                        void run("retry", () => onRetry(doc.id))
                                    }
                                />
                            )}
                            <ActionButton
                                label={t("common.actions.delete")}
                                icon={Trash2}
                                danger
                                busy={busyAction === "delete"}
                                disabled={busyAction != null}
                                onClick={() => setDeleteConfirmOpen(true)}
                            />
                        </div>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept={SUPPORTED_DOCUMENT_ACCEPT}
                            className="hidden"
                            onChange={(event) => {
                                const file = event.target.files?.[0];
                                event.target.value = "";
                                if (!file) return;
                                void run("upload", () =>
                                    onUploadNewVersion(doc.id, file),
                                );
                            }}
                        />

                        <dl className="mt-6 divide-y divide-gray-100 text-xs">
                            <DataRow
                                label={t("common.fields.name")}
                                value={selectedFilename}
                            />
                            <DataRow
                                label={t("documents.version", {
                                    version: selectedVersionNumber,
                                })}
                                value={
                                    typeof selectedVersion?.size_bytes === "number"
                                        ? formatFileSize(selectedVersion.size_bytes)
                                        : typeof doc.size_bytes === "number"
                                          ? formatFileSize(doc.size_bytes)
                                          : "—"
                                }
                            />
                            <DataRow
                                label={t("common.fields.createdAt")}
                                value={formatDate(
                                    selectedVersion?.created_at ??
                                        doc.created_at ??
                                        "",
                                )}
                            />
                            <DataRow
                                label={t("common.fields.updatedAt")}
                                value={formatDate(doc.updated_at ?? "")}
                            />
                        </dl>

                        <div className="mt-6">
                            <div className="mb-2 flex items-center justify-between">
                                <span className="text-xs font-medium text-gray-500">
                                    {t("documents.version", {
                                        version:
                                            doc.active_version_number ?? 1,
                                    })}
                                </span>
                                {versionsLoading && (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />
                                )}
                            </div>
                            <div className="space-y-1">
                                <button
                                    type="button"
                                    onClick={() => onSelectVersion(null)}
                                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs ${
                                        isCurrent
                                            ? "bg-gray-100 text-gray-900"
                                            : "text-gray-600 hover:bg-gray-50"
                                    }`}
                                >
                                    <span className="min-w-0 flex-1 truncate">
                                        {doc.filename}
                                    </span>
                                    <VersionChip n={doc.active_version_number ?? 1} />
                                </button>
                                {[...versions]
                                    .filter(
                                        (version) =>
                                            version.id !== currentVersionId,
                                    )
                                    .reverse()
                                    .map((version) => (
                                        <button
                                            key={version.id}
                                            type="button"
                                            disabled={version.deleted_at != null}
                                            onClick={() =>
                                                onSelectVersion(version.id)
                                            }
                                            className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs disabled:opacity-40 ${
                                                versionId === version.id
                                                    ? "bg-gray-100 text-gray-900"
                                                    : "text-gray-600 hover:bg-gray-50"
                                            }`}
                                        >
                                            <span className="min-w-0 flex-1 truncate">
                                                {version.filename ??
                                                    t("documents.version", {
                                                        version:
                                                            version.version_number ??
                                                            1,
                                                    })}
                                            </span>
                                            <VersionChip n={version.version_number} />
                                        </button>
                                    ))}
                            </div>
                        </div>
                    </aside>
                </div>
            </section>
            <ConfirmPopup
                open={deleteConfirmOpen}
                title={t("documents.deleteConfirm.title")}
                message={t("documents.deleteConfirm.body", {
                    name: doc.filename,
                })}
                confirmLabel={t("documents.deleteConfirm.action")}
                confirmStatus={busyAction === "delete" ? "loading" : "idle"}
                cancelLabel={t("common.actions.cancel")}
                cancelDisabled={busyAction === "delete"}
                onCancel={() => {
                    if (busyAction !== "delete") setDeleteConfirmOpen(false);
                }}
                onConfirm={() =>
                    void run("delete", async () => {
                        await onDelete(doc);
                        setDeleteConfirmOpen(false);
                        onClose();
                    })
                }
            />
        </div>
    );

    return createPortal(panel, document.body);
}

function DocumentPreview({
    document,
    versionId,
    filename,
    fileType,
}: {
    document: VeraDocumentWire;
    versionId: string | null;
    filename: string;
    fileType: string | null;
}) {
    const { t } = useI18n();
    if (document.status === "pending" || document.status === "processing") {
        return (
            <div className="flex h-full min-h-[360px] items-center justify-center gap-2 text-sm text-gray-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("common.status.processing")}
            </div>
        );
    }
    if (document.status === "error") {
        return <ViewerError message={t("documents.errors.load")} />;
    }

    const kind = fileTypeKind(fileType ?? filename);
    const extension = filename.split(".").pop()?.toLowerCase();
    if (kind === "pdf") {
        return (
            <PdfView
                doc={{ document_id: document.id, version_id: versionId }}
                rounded={false}
            />
        );
    }
    if (kind === "word" && extension === "docx") {
        return (
            <DocxView
                documentId={document.id}
                versionId={versionId}
                rounded={false}
            />
        );
    }
    if (kind === "excel") {
        return (
            <SpreadsheetView
                documentId={document.id}
                versionId={versionId}
                rounded={false}
            />
        );
    }
    if (extension === "txt" || extension === "md") {
        return <TextView documentId={document.id} versionId={versionId} />;
    }
    return <ViewerError message={t("documents.errors.unsupported")} />;
}

function ActionButton({
    label,
    icon: Icon,
    busy,
    disabled,
    danger = false,
    onClick,
}: {
    label: string;
    icon: typeof Download;
    busy: boolean;
    disabled: boolean;
    danger?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors disabled:opacity-40 ${
                danger
                    ? "border-red-200 text-red-600 hover:bg-red-50"
                    : "border-gray-200 text-gray-600 hover:bg-gray-50 hover:text-gray-900"
            }`}
        >
            {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
                <Icon className="h-3.5 w-3.5" />
            )}
            {label}
        </button>
    );
}

function DataRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3 py-2.5">
            <dt className="truncate text-gray-400">{label}</dt>
            <dd className="truncate text-right text-gray-700" title={value}>
                {value}
            </dd>
        </div>
    );
}

function filenameExtension(filename: string) {
    const trimmed = filename.trim();
    const dotIndex = trimmed.lastIndexOf(".");
    if (dotIndex <= 0 || dotIndex === trimmed.length - 1) return null;
    return trimmed.slice(dotIndex).toLowerCase();
}
