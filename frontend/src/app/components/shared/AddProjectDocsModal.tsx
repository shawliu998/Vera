"use client";

// Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/modals/AddProjectDocsModal.tsx
import { useEffect, useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { SUPPORTED_DOCUMENT_ACCEPT } from "@/app/lib/documentUploadValidation";
import {
    attachVeraProjectDocument,
    listVeraStandaloneDocuments,
    uploadVeraDocument,
} from "@/app/lib/veraApi";
import type { VeraDocumentWire } from "@/app/lib/veraWireTypes";
import { FileDirectory } from "./FileDirectory";
import { Modal } from "./Modal";

interface Props {
    open: boolean;
    onClose: () => void;
    onSelect: (documents: VeraDocumentWire[]) => void;
    breadcrumb: string[];
    projectId: string;
    excludeDocIds?: Set<string>;
    allowMultiple?: boolean;
}

export function AddProjectDocsModal({
    open,
    onClose,
    onSelect,
    breadcrumb,
    projectId,
    excludeDocIds,
    allowMultiple = true,
}: Props) {
    const { t, errorMessage } = useI18n();
    const [documents, setDocuments] = useState<VeraDocumentWire[]>([]);
    const [loading, setLoading] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [uploading, setUploading] = useState(false);
    const [attaching, setAttaching] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const attachingRef = useRef(false);
    const uploadingRef = useRef(false);

    useEffect(() => {
        if (!open) return;
        const controller = new AbortController();
        queueMicrotask(() => {
            if (controller.signal.aborted) return;
            setSelectedIds(new Set());
            setError(null);
            setLoading(true);
        });
        listVeraStandaloneDocuments({}, controller.signal)
            .then((loaded) => {
                if (controller.signal.aborted) return;
                setDocuments(
                    loaded.filter((document) => !excludeDocIds?.has(document.id)),
                );
            })
            .catch((reason: unknown) => {
                if (!controller.signal.aborted) {
                    setDocuments([]);
                    setError(errorMessage(reason as Error));
                }
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [errorMessage, excludeDocIds, open]);

    const handleAttach = async () => {
        if (selectedIds.size === 0 || attachingRef.current) return;
        attachingRef.current = true;
        setAttaching(true);
        setError(null);
        const selected = documents.filter((document) =>
            selectedIds.has(document.id),
        );
        const settled = await Promise.allSettled(
            selected.map((document) =>
                attachVeraProjectDocument(projectId, document.id),
            ),
        );
        const attached = settled.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
        );
        if (attached.length > 0) onSelect(attached);
        const failedIds = new Set(
            selected
                .filter((_, index) => settled[index]?.status === "rejected")
                .map((document) => document.id),
        );
        setSelectedIds(failedIds);
        setDocuments((current) =>
            current.filter(
                (document) =>
                    !attached.some((item) => item.id === document.id),
            ),
        );
        const failure = settled.find(
            (result): result is PromiseRejectedResult =>
                result.status === "rejected",
        );
        if (failure) setError(errorMessage(failure.reason as Error));
        attachingRef.current = false;
        setAttaching(false);
        if (!failure) onClose();
    };

    const handleUpload = async (
        event: React.ChangeEvent<HTMLInputElement>,
    ) => {
        const files = Array.from(event.target.files ?? []);
        if (files.length === 0 || uploadingRef.current) return;
        uploadingRef.current = true;
        setUploading(true);
        setError(null);
        const settled = await Promise.allSettled(
            files.map((file) =>
                uploadVeraDocument({ file, projectId, folderId: null }),
            ),
        );
        const uploaded = settled.flatMap((result) =>
            result.status === "fulfilled" ? [result.value.document] : [],
        );
        if (uploaded.length > 0) onSelect(uploaded);
        const failure = settled.find(
            (result): result is PromiseRejectedResult =>
                result.status === "rejected",
        );
        if (failure) setError(errorMessage(failure.reason as Error));
        uploadingRef.current = false;
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
        if (!failure) onClose();
    };

    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={breadcrumb}
            secondaryAction={{
                label: uploading
                    ? t("common.status.processing")
                    : t("common.actions.upload"),
                icon: uploading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                    <Upload className="h-3.5 w-3.5" />
                ),
                onClick: () => fileInputRef.current?.click(),
                disabled: uploading || attaching,
            }}
            cancelAction={{
                label: t("common.actions.cancel"),
                onClick: onClose,
                disabled: uploading || attaching,
            }}
            primaryAction={{
                label: t("documents.addToProject"),
                onClick: () => void handleAttach(),
                disabled:
                    selectedIds.size === 0 || uploading || attaching,
                icon: attaching ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : undefined,
            }}
        >
            <input
                ref={fileInputRef}
                type="file"
                accept={SUPPORTED_DOCUMENT_ACCEPT}
                multiple={allowMultiple}
                className="hidden"
                onChange={(event) => void handleUpload(event)}
            />
            {error && (
                <p role="alert" className="mb-3 text-xs text-red-600">
                    {error}
                </p>
            )}
            <FileDirectory
                standaloneDocs={documents}
                directoryProjects={[]}
                loading={loading}
                selectedIds={selectedIds}
                onChange={setSelectedIds}
                allowMultiple={allowMultiple}
                searchable
                searchAutoFocus
                showProjectTabs={false}
            />
        </Modal>
    );
}
