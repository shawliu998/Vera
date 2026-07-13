"use client";

import { useState } from "react";
import {
  CircleAlert,
  ExternalLink,
  FileText,
  LoaderCircle,
  RotateCw,
  ScanSearch,
} from "lucide-react";
import {
  retryAletheiaMatterDocumentParse,
  type AletheiaMatterDocumentRecord,
} from "@/app/lib/aletheiaApi";
import {
  useOriginalDocumentAccess,
} from "./originalDocumentAccess";
import { OriginalEvidenceViewer } from "./OriginalEvidenceViewer";

function OriginalDocumentCommand({
  matterId,
  documentId,
  documentName,
}: {
  matterId: string;
  documentId: string;
  documentName: string;
}) {
  const access = useOriginalDocumentAccess();
  return (
    <div className="shrink-0 self-start sm:text-right">
      <button
        type="button"
        title="Save the stored original and open it in the default external viewer"
        aria-label={`Save and open original ${documentName}`}
        disabled={access.status === "busy"}
        onClick={() =>
          void access.saveAndOpen({
            matterId,
            documentId,
            suggestedName: documentName,
          })
        }
        className="inline-flex h-8 items-center gap-2 border border-gray-300 bg-white px-2.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
      >
        {access.status === "busy" ? (
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <ExternalLink className="h-3.5 w-3.5" />
        )}
        Save &amp; open original
      </button>
      {access.status !== "idle" && (
        <p
          role="status"
          data-access-status={access.status}
          className={`mt-1 max-w-72 text-left text-[11px] leading-4 sm:text-right ${access.status === "access_failed" || access.status === "open_failed" ? "text-red-700" : "text-gray-500"}`}
        >
          {access.message}
        </p>
      )}
    </div>
  );
}

function metadataString(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function metadataNumber(
  metadata: Record<string, unknown>,
  key: string,
): number {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parserMetadata(metadata: Record<string, unknown>) {
  const value = metadata.parserMetadata;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function MatterDocumentStatusList({
  matterId,
  documents,
  focusedDocumentId,
  onChanged,
}: {
  matterId: string;
  documents: AletheiaMatterDocumentRecord[];
  focusedDocumentId?: string | null;
  onChanged: () => void | Promise<void>;
}) {
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<Record<string, string>>({});
  const [inspectedDocument, setInspectedDocument] = useState<{
    id: string;
    name: string;
  } | null>(null);

  async function retry(documentId: string) {
    setRetryingId(documentId);
    setRetryError((current) => ({ ...current, [documentId]: "" }));
    try {
      await retryAletheiaMatterDocumentParse(matterId, documentId);
      await onChanged();
    } catch (reason) {
      setRetryError((current) => ({
        ...current,
        [documentId]:
          reason instanceof Error ? reason.message : "Text extraction failed",
      }));
      await onChanged();
    } finally {
      setRetryingId(null);
    }
  }

  if (documents.length === 0) return null;

  return (
    <section aria-label="Imported document status">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-gray-950">Imported files</h3>
        <span className="text-xs tabular-nums text-gray-500">
          {documents.length} total
        </span>
      </div>
      <div className="divide-y divide-gray-200 border-y border-gray-200">
        {documents.map((document) => {
          const attempts = metadataNumber(
            document.metadata,
            "parseAttemptCount",
          );
          const storedError =
            metadataString(document.metadata, "lastParseError") ??
            metadataString(document.metadata, "parseFailureReason");
          const error = retryError[document.id] || storedError;
          const retrying = retryingId === document.id;
          const parser = parserMetadata(document.metadata);
          const ocrPageCount = metadataNumber(parser, "ocrPageCount");
          const ocrConfidence = metadataNumber(parser, "averageOcrConfidence");
          const ocrIndexed =
            document.parsed_status === "parsed" &&
            metadataString(parser, "ocrEngine") === "apple-vision" &&
            ocrPageCount > 0;
          const canInspectOriginal =
            metadataString(document.metadata, "mimeType") ===
            "application/pdf";
          return (
            <div
              key={document.id}
              data-testid="matter-document-status-row"
              data-object-focus-key={`document:${document.id}`}
              tabIndex={-1}
              className={`flex flex-col gap-2 border-l-2 px-3 py-3 outline-none sm:flex-row sm:items-start sm:justify-between ${
                focusedDocumentId === document.id
                  ? "border-gray-900 bg-gray-50"
                  : "border-transparent"
              }`}
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <FileText className="h-4 w-4 shrink-0 text-gray-400" />
                  <p className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">
                    {document.name}
                  </p>
                  <span className="shrink-0 text-xs text-gray-500">
                    {document.parsed_status === "parsed"
                      ? "Indexed"
                      : document.parsed_status === "needs_ocr"
                        ? "OCR required"
                        : document.parsed_status === "failed"
                          ? "Extraction failed"
                          : "Processing"}
                  </span>
                </div>
                {document.parsed_status === "needs_ocr" && (
                  <p className="mt-1 flex items-center gap-1.5 pl-6 text-xs text-amber-700">
                    <CircleAlert className="h-3.5 w-3.5" />
                    Local OCR is unavailable or found no text. Retry after
                    checking the runtime and source quality.
                  </p>
                )}
                {ocrIndexed && (
                  <p
                    className={`mt-1 pl-6 text-xs ${ocrConfidence < 0.7 ? "text-amber-700" : "text-gray-500"}`}
                  >
                    Apple Vision OCR · {ocrPageCount}{" "}
                    {ocrPageCount === 1 ? "page" : "pages"} · average confidence{" "}
                    {Math.round(ocrConfidence * 100)}%
                    {ocrConfidence < 0.7
                      ? " · verify against the original before relying on quotations"
                      : ""}
                  </p>
                )}
                {document.parsed_status === "failed" && error && (
                  <p className="mt-1 max-w-3xl pl-6 text-xs text-red-700">
                    {error}
                    {attempts > 0
                      ? ` · ${attempts} retry attempt${attempts === 1 ? "" : "s"}`
                      : ""}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                {canInspectOriginal && (
                  <button
                    type="button"
                    aria-label={`Inspect original ${document.name}`}
                    onClick={() =>
                      setInspectedDocument({
                        id: document.id,
                        name: document.name,
                      })
                    }
                    className="inline-flex h-8 items-center gap-2 border border-gray-300 bg-white px-2.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    <ScanSearch className="h-3.5 w-3.5" />
                    Inspect original
                  </button>
                )}
                <OriginalDocumentCommand
                  matterId={matterId}
                  documentId={document.id}
                  documentName={document.name}
                />
                {(document.parsed_status === "failed" ||
                  document.parsed_status === "needs_ocr") && (
                  <button
                    type="button"
                    data-testid={`retry-document-${document.id}`}
                    disabled={retrying}
                    onClick={() => void retry(document.id)}
                    className="flex h-8 shrink-0 items-center gap-2 self-start rounded-md border border-gray-200 px-3 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                  >
                    {retrying ? (
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RotateCw className="h-3.5 w-3.5" />
                    )}
                    {document.parsed_status === "needs_ocr"
                      ? "Retry OCR"
                      : "Retry extraction"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {inspectedDocument && (
        <OriginalEvidenceViewer
          open
          matterId={matterId}
          documentId={inspectedDocument.id}
          filename={inspectedDocument.name}
          recordedPage={null}
          onClose={() => setInspectedDocument(null)}
        />
      )}
    </section>
  );
}
