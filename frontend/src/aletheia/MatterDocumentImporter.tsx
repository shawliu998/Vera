"use client";

import { useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  FileUp,
  FolderOpen,
  LoaderCircle,
  RotateCw,
  X,
} from "lucide-react";
import {
  uploadAletheiaMatterDocuments,
  type AletheiaMatterDocumentRecord,
} from "@/app/lib/aletheiaApi";
import { cn } from "@/lib/utils";

type ImportItemStatus =
  "queued" | "uploading" | "imported" | "attention" | "failed";

type ImportItem = {
  id: string;
  file: File;
  displayPath: string;
  status: ImportItemStatus;
  detail: string | null;
  documentId: string | null;
};

const allowedExtension = /\.(pdf|docx|xlsx|txt|md)$/i;
const batchSize = 20;

function itemId(index: number) {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${index}`;
}

function documentStatus(document: AletheiaMatterDocumentRecord) {
  if (document.parsed_status === "parsed") {
    return { status: "imported" as const, detail: "Indexed and searchable" };
  }
  if (document.parsed_status === "needs_ocr") {
    return {
      status: "attention" as const,
      detail: "Saved, but this PDF needs OCR before it can be searched",
    };
  }
  return {
    status: "attention" as const,
    detail: "Saved, but text extraction failed",
  };
}

export function MatterDocumentImporter({
  matterId,
  onImported,
}: {
  matterId: string;
  onImported: () => void | Promise<void>;
}) {
  const filesInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<ImportItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  function updateItems(ids: string[], patch: Partial<ImportItem>) {
    const selected = new Set(ids);
    setItems((current) =>
      current.map((item) =>
        selected.has(item.id) ? { ...item, ...patch } : item,
      ),
    );
  }

  async function upload(selected: ImportItem[]) {
    if (selected.length === 0) return;
    setBusy(true);
    let importedAny = false;
    try {
      for (let offset = 0; offset < selected.length; offset += batchSize) {
        const chunk = selected.slice(offset, offset + batchSize);
        const chunkIds = chunk.map((item) => item.id);
        updateItems(chunkIds, { status: "uploading", detail: null });
        try {
          const result = await uploadAletheiaMatterDocuments(
            matterId,
            chunk.map((item) => item.file),
          );
          if (result.imported > 0) importedAny = true;
          const documentsByName = new Map<
            string,
            AletheiaMatterDocumentRecord[]
          >();
          for (const document of result.documents) {
            documentsByName.set(document.name, [
              ...(documentsByName.get(document.name) ?? []),
              document,
            ]);
          }
          const errorsByName = new Map<string, string[]>();
          for (const error of result.errors) {
            errorsByName.set(error.filename, [
              ...(errorsByName.get(error.filename) ?? []),
              error.detail,
            ]);
          }
          setItems((current) =>
            current.map((item) => {
              if (!chunkIds.includes(item.id)) return item;
              const document = documentsByName.get(item.file.name)?.shift();
              if (document) {
                const parsed = documentStatus(document);
                return {
                  ...item,
                  ...parsed,
                  documentId: document.id,
                };
              }
              const detail = errorsByName.get(item.file.name)?.shift();
              return {
                ...item,
                status: "failed",
                detail: detail ?? "The file was not imported",
              };
            }),
          );
        } catch (reason) {
          updateItems(chunkIds, {
            status: "failed",
            detail: reason instanceof Error ? reason.message : "Upload failed",
          });
        }
      }
      if (importedAny) await onImported();
    } finally {
      setBusy(false);
    }
  }

  function selectFiles(files: FileList | File[]) {
    const selected = Array.from(files);
    if (selected.length === 0) return;
    const accepted = selected.slice(0, 100).map((file, index) => ({
      id: itemId(index),
      file,
      displayPath: file.webkitRelativePath || file.name,
      status: allowedExtension.test(file.name)
        ? ("queued" as const)
        : ("failed" as const),
      detail: allowedExtension.test(file.name) ? null : "Unsupported file type",
      documentId: null,
    }));
    const overflow = selected.slice(100).map((file, index) => ({
      id: itemId(100 + index),
      file,
      displayPath: file.webkitRelativePath || file.name,
      status: "failed" as const,
      detail: "A single import is limited to 100 files",
      documentId: null,
    }));
    const next = [...accepted, ...overflow];
    setItems(next);
    void upload(next.filter((item) => item.status === "queued"));
  }

  const completed = items.filter((item) => item.status === "imported").length;
  const attention = items.filter((item) => item.status === "attention").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const retryable = items.filter(
    (item) => item.status === "failed" && allowedExtension.test(item.file.name),
  );

  return (
    <section
      className="border-y border-gray-200 py-4"
      aria-label="Document import"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-gray-950">
            Import case files
          </h3>
          <p className="mt-1 text-xs text-gray-500">
            PDF, DOCX, XLSX, TXT or Markdown. Up to 100 files, 100 MB each.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => filesInputRef.current?.click()}
            className="flex h-8 items-center gap-2 rounded-md border border-gray-200 px-3 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            <FileUp className="h-3.5 w-3.5" /> Files
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => folderInputRef.current?.click()}
            className="flex h-8 items-center gap-2 rounded-md border border-gray-200 px-3 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            <FolderOpen className="h-3.5 w-3.5" /> Folder
          </button>
          <input
            ref={filesInputRef}
            data-testid="matter-document-files-input"
            type="file"
            multiple
            accept=".pdf,.docx,.xlsx,.txt,.md"
            className="hidden"
            onChange={(event) => {
              selectFiles(event.target.files ?? []);
              event.currentTarget.value = "";
            }}
          />
          <input
            ref={(node) => {
              folderInputRef.current = node;
              node?.setAttribute("webkitdirectory", "");
            }}
            type="file"
            data-testid="matter-document-folder-input"
            multiple
            accept=".pdf,.docx,.xlsx,.txt,.md"
            className="hidden"
            onChange={(event) => {
              selectFiles(event.target.files ?? []);
              event.currentTarget.value = "";
            }}
          />
        </div>
      </div>

      <button
        type="button"
        disabled={busy}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          selectFiles(event.dataTransfer.files);
        }}
        onClick={() => filesInputRef.current?.click()}
        className={cn(
          "mt-4 flex min-h-16 w-full items-center justify-center border border-dashed border-gray-300 px-4 text-sm text-gray-500 transition-colors hover:border-gray-400 hover:text-gray-800 disabled:opacity-40",
          dragging && "border-gray-950 bg-gray-50 text-gray-950",
        )}
      >
        Drop case files here
      </button>

      {items.length > 0 ? (
        <div className="mt-4">
          <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 pb-2 text-xs text-gray-500">
            <span>{items.length} selected</span>
            <span>{completed} indexed</span>
            {attention > 0 ? (
              <span className="text-amber-700">
                {attention} {attention === 1 ? "needs" : "need"} attention
              </span>
            ) : null}
            {failed > 0 ? (
              <span className="text-red-700">{failed} failed</span>
            ) : null}
            <div className="ml-auto flex items-center gap-2">
              {retryable.length > 0 && !busy ? (
                <button
                  type="button"
                  onClick={() => void upload(retryable)}
                  className="flex items-center gap-1.5 text-gray-600 hover:text-gray-950"
                >
                  <RotateCw className="h-3.5 w-3.5" /> Retry failed
                </button>
              ) : null}
              {!busy ? (
                <button
                  type="button"
                  onClick={() => setItems([])}
                  className="grid h-7 w-7 place-items-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                  aria-label="Clear import results"
                  title="Clear import results"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </div>
          <div className="max-h-56 overflow-y-auto">
            {items.map((item) => (
              <div
                key={item.id}
                data-testid="matter-document-import-row"
                className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 border-b border-gray-100 py-2 text-xs"
              >
                {item.status === "uploading" || item.status === "queued" ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin text-gray-400" />
                ) : item.status === "imported" ? (
                  <Check className="h-3.5 w-3.5 text-emerald-600" />
                ) : (
                  <CircleAlert
                    className={cn(
                      "h-3.5 w-3.5",
                      item.status === "attention"
                        ? "text-amber-600"
                        : "text-red-600",
                    )}
                  />
                )}
                <span
                  className="truncate text-gray-800"
                  title={item.displayPath}
                >
                  {item.displayPath}
                </span>
                <span
                  className={cn(
                    "max-w-72 truncate text-right text-gray-500",
                    item.status === "attention" && "text-amber-700",
                    item.status === "failed" && "text-red-700",
                  )}
                  title={item.detail ?? item.status}
                >
                  {item.detail ?? item.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
