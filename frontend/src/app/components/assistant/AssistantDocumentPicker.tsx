"use client";

// Local adaptation of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/modals/AddDocumentsModal.tsx
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, Search } from "lucide-react";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import { Modal } from "@/app/components/shared/Modal";
import { listVeraStandaloneDocuments } from "@/app/lib/veraApi";
import type { VeraDocumentWire } from "@/app/lib/veraWireTypes";
import { useI18n } from "@/app/i18n";

export function AssistantDocumentPicker({
  open,
  onClose,
  onSelect,
  documents: providedDocuments,
  selectedIds,
  title,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (documents: VeraDocumentWire[]) => void;
  documents?: readonly VeraDocumentWire[];
  selectedIds: ReadonlySet<string>;
  title?: string;
}) {
  const { t } = useI18n();
  const resolvedTitle = title ?? t("assistant.documents.add");
  const [documents, setDocuments] = useState<VeraDocumentWire[]>([]);
  const [draftIds, setDraftIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setDraftIds(new Set(selectedIds));
      setQuery("");
      setError(null);
      if (providedDocuments) {
        setDocuments([...providedDocuments]);
        setLoading(false);
        return;
      }
      setLoading(true);
      listVeraStandaloneDocuments({}, controller.signal)
        .then((items) => {
          if (!controller.signal.aborted) setDocuments(items);
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setError(reason);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    });
    return () => controller.abort();
  }, [open, providedDocuments, selectedIds]);

  const available = useMemo(
    () => documents.filter((document) => document.status === "ready"),
    [documents],
  );
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = normalized
    ? available.filter((document) =>
        document.filename.toLocaleLowerCase().includes(normalized),
      )
    : available;

  const apply = () => {
    onSelect(available.filter((document) => draftIds.has(document.id)));
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      breadcrumbs={[t("common.appName"), resolvedTitle]}
      cancelAction={{ label: t("common.actions.cancel"), onClick: onClose }}
      primaryAction={{
        label: draftIds.size
          ? t("assistant.documents.addCount", { count: draftIds.size })
          : t("assistant.documents.add"),
        onClick: apply,
        disabled: draftIds.size === 0,
      }}
    >
      <label className="mb-3 flex h-9 items-center gap-2 rounded-xl border border-white/70 bg-white/70 px-3 text-gray-400 shadow-inner">
        <Search className="h-3.5 w-3.5" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("assistant.documents.search")}
          className="min-w-0 flex-1 bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400"
        />
      </label>
      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("assistant.documents.loading")}
        </div>
      ) : error ? (
        <div
          role="alert"
          className="flex flex-1 items-center justify-center gap-2 text-sm text-red-600"
        >
          <AlertCircle className="h-4 w-4" />
          {t("assistant.documents.loadError")}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
          {t("assistant.documents.empty")}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-gray-100 bg-white/40">
          {filtered.map((document) => {
            const checked = draftIds.has(document.id);
            return (
              <label
                key={document.id}
                className="flex cursor-pointer items-center gap-3 border-b border-gray-100 px-3 py-2.5 text-sm transition-colors last:border-b-0 hover:bg-white/80"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    setDraftIds((current) => {
                      const next = new Set(current);
                      if (next.has(document.id)) next.delete(document.id);
                      else next.add(document.id);
                      return next;
                    })
                  }
                  className="h-3 w-3 accent-black"
                />
                <FileTypeIcon
                  fileType={document.file_type}
                  className="h-4 w-4 shrink-0"
                />
                <span className="min-w-0 flex-1 truncate text-gray-800">
                  {document.filename}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
