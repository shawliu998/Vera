"use client";

// Adapted from Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/tabular/TabularReviewDetailsModal.tsx document picker.

import { useEffect, useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { Modal } from "@/app/components/shared/Modal";
import { useI18n } from "@/app/i18n";
import { listVeraProjectDocuments } from "@/app/lib/veraApi";
import type { VeraDocumentWire } from "@/app/lib/veraWireTypes";

export function TabularDocumentsModal({
  open,
  projectId,
  selectedIds,
  columnCount,
  busy = false,
  onClose,
  onSave,
}: {
  open: boolean;
  projectId: string;
  selectedIds: string[];
  columnCount: number;
  busy?: boolean;
  onClose: () => void;
  onSave: (documentIds: string[]) => Promise<void>;
}) {
  const { t, errorMessage } = useI18n();
  const [documents, setDocuments] = useState<VeraDocumentWire[]>([]);
  const [selection, setSelection] = useState<string[]>(selectedIds);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setSelection(selectedIds);
        setLoading(true);
        setError(null);
      }
    });
    listVeraProjectDocuments(projectId, {}, controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setDocuments(loaded);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason as Error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [errorMessage, open, projectId, selectedIds]);

  const cellCount = selection.length * columnCount;
  const matrixTooLarge = cellCount > 10_000;

  const save = async () => {
    if (saving || busy || matrixTooLarge) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(selection);
      onClose();
    } catch (reason) {
      setError(errorMessage(reason as Error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!saving && !busy) onClose();
      }}
      breadcrumbs={[t("tabular.title"), t("tabular.documents.manage")]}
      primaryAction={{
        label: saving ? t("common.status.saving") : t("common.actions.save"),
        onClick: () => void save(),
        disabled: saving || busy || matrixTooLarge,
        icon: saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined,
      }}
      cancelAction={{
        label: t("common.actions.cancel"),
        onClick: onClose,
        disabled: saving || busy,
      }}
    >
      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      )}
      <p className="mb-3 text-xs text-gray-500">
        {t("tabular.documents.readyOnly")}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-gray-100">
        {loading ? (
          <div className="flex min-h-40 items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
          </div>
        ) : documents.length === 0 ? (
          <div className="flex min-h-40 items-center justify-center px-6 text-center text-xs text-gray-400">
            {t("tabular.new.noDocuments")}
          </div>
        ) : (
          documents.map((document) => {
            const ready = document.status === "ready";
            const checked = selection.includes(document.id);
            const canAdd =
              checked || (ready && (selection.length + 1) * columnCount <= 10_000);
            return (
              <label
                key={document.id}
                className={`flex items-center gap-3 border-b border-gray-50 px-3 py-2.5 text-xs last:border-0 ${
                  canAdd
                    ? "cursor-pointer hover:bg-gray-50"
                    : "cursor-not-allowed opacity-50"
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!canAdd}
                  onChange={() =>
                    setSelection((current) =>
                      checked
                        ? current.filter((id) => id !== document.id)
                        : [...current, document.id],
                    )
                  }
                  className="h-3 w-3 accent-black"
                />
                <FileText className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                <span className="min-w-0 flex-1 truncate text-gray-700">
                  {document.filename}
                </span>
                {!ready && (
                  <span className="text-[10px] text-gray-400">
                    {t(`tabular.documentStatus.${document.status}`)}
                  </span>
                )}
              </label>
            );
          })
        )}
      </div>
      <p
        className={`mt-3 text-[11px] ${
          matrixTooLarge ? "text-red-600" : "text-gray-400"
        }`}
      >
        {t("tabular.new.matrixSize", {
          documents: selection.length,
          columns: columnCount,
          cells: cellCount,
        })}
        {matrixTooLarge ? ` · ${t("tabular.documents.matrixLimit")}` : ""}
      </p>
    </Modal>
  );
}
