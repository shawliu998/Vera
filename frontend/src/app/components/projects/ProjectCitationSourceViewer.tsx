"use client";

import { useEffect, useRef } from "react";
import { FileText, ScanSearch, X } from "lucide-react";
import { fileTypeKind } from "@/app/components/shared/FileTypeIcon";
import { DocxView } from "@/app/components/shared/views/DocxView";
import { PdfView } from "@/app/components/shared/views/PdfView";
import { SpreadsheetView } from "@/app/components/shared/views/SpreadsheetView";
import { TextView } from "@/app/components/shared/views/TextView";
import { useI18n } from "@/app/i18n";
import type { VeraResolvedProjectCitation } from "@/app/lib/veraProjectSourceApi";

export type ProjectAssistantCitationSource = Readonly<{
  kind: "assistant_document";
  documentId: string;
  versionId: string;
  filename: string;
  quote: string;
  page: number | null;
}>;

type ViewerSource =
  | Readonly<{
      kind: "studio_anchor";
      citation: VeraResolvedProjectCitation;
    }>
  | ProjectAssistantCitationSource;

interface Props {
  source: ViewerSource;
  onClose: () => void;
}

type NormalizedSource = Readonly<{
  kind: ViewerSource["kind"];
  documentId: string;
  versionId: string;
  title: string;
  filename: string;
  mimeType: string | null;
  page: number | null;
  before: string;
  quote: string;
  after: string;
  snapshotId: string | null;
  chunkId: string | null;
}>;

function shortId(value: string) {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function normalizeSource(source: ViewerSource): NormalizedSource {
  if (source.kind === "assistant_document") {
    return {
      kind: source.kind,
      documentId: source.documentId,
      versionId: source.versionId,
      title: source.filename,
      filename: source.filename,
      mimeType: null,
      page: source.page,
      before: "",
      quote: source.quote,
      after: "",
      snapshotId: null,
      chunkId: null,
    };
  }
  const citation = source.citation;
  return {
    kind: source.kind,
    documentId: citation.document.document_id,
    versionId: citation.document.version_id,
    title: citation.document.title,
    filename: citation.document.filename,
    mimeType: citation.document.mime_type,
    page: citation.page,
    before: citation.chunk.text.slice(0, citation.quote_start),
    quote: citation.chunk.text.slice(citation.quote_start, citation.quote_end),
    after: citation.chunk.text.slice(citation.quote_end),
    snapshotId: citation.snapshot_id,
    chunkId: citation.chunk.id,
  };
}

function previewKind(source: NormalizedSource) {
  const extension = source.filename.split(".").pop()?.toLowerCase() ?? "";
  const kind = fileTypeKind(source.mimeType ?? source.filename);
  if (
    source.mimeType?.toLowerCase() === "application/pdf" ||
    kind === "pdf" ||
    extension === "pdf"
  ) {
    return "pdf" as const;
  }
  if (kind === "word" && extension === "docx") return "docx" as const;
  if (kind === "excel") return "spreadsheet" as const;
  if (extension === "txt" || extension === "md") return "text" as const;
  return null;
}

export function ProjectCitationSourceViewer({ source, onClose }: Props) {
  const { t, formatNumber } = useI18n();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const normalized = normalizeSource(source);
  const preview = previewKind(normalized);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex bg-gray-950/35 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-source-viewer-title"
      data-testid="project-citation-source-viewer"
    >
      <section className="m-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/70 bg-[#f7f8fa] shadow-2xl sm:m-4 lg:m-6">
        <header className="flex min-w-0 items-center gap-3 border-b border-gray-200 bg-white/90 px-4 py-3 backdrop-blur-xl sm:px-5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-600">
            <ScanSearch className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="project-source-viewer-title"
              className="truncate text-sm font-semibold text-gray-950"
            >
              {normalized.title}
            </h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
              <span className="truncate">{normalized.filename}</span>
              {normalized.page !== null && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {t("studio.sourceViewer.page", {
                      page: formatNumber(normalized.page),
                    })}
                  </span>
                </>
              )}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t("common.actions.close")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div
          className={`grid min-h-0 flex-1 gap-px bg-gray-200 ${
            preview
              ? "lg:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.55fr)]"
              : ""
          }`}
        >
          {preview && (
            <section
              className="min-h-[22rem] bg-white lg:min-h-0"
              aria-label={
                preview === "pdf"
                  ? t("studio.sourceViewer.originalPdf")
                  : t("studio.sourceViewer.originalDocument")
              }
              data-testid={
                preview === "pdf"
                  ? "project-citation-original-pdf"
                  : "project-citation-original-document"
              }
            >
              {preview === "pdf" ? (
                <PdfView
                  doc={{
                    document_id: normalized.documentId,
                    version_id: normalized.versionId,
                  }}
                  page={normalized.page}
                  rounded={false}
                />
              ) : preview === "docx" ? (
                <DocxView
                  documentId={normalized.documentId}
                  versionId={normalized.versionId}
                  rounded={false}
                />
              ) : preview === "spreadsheet" ? (
                <SpreadsheetView
                  documentId={normalized.documentId}
                  versionId={normalized.versionId}
                  rounded={false}
                />
              ) : (
                <TextView
                  documentId={normalized.documentId}
                  versionId={normalized.versionId}
                />
              )}
            </section>
          )}

          <aside className="min-h-0 overflow-y-auto bg-white p-4 sm:p-5">
            <div className="flex items-center gap-2 text-xs font-semibold text-gray-900">
              <FileText className="h-4 w-4 text-gray-500" aria-hidden="true" />
              {t("studio.sourceViewer.verifiedExcerpt")}
            </div>
            <p className="mt-2 text-xs leading-5 text-gray-500">
              {t(
                normalized.kind === "studio_anchor"
                  ? "studio.sourceViewer.integrityNote"
                  : "studio.sourceViewer.assistantIntegrityNote",
              )}
            </p>
            <pre
              className="mt-4 whitespace-pre-wrap break-words rounded-xl border border-gray-200 bg-gray-50 p-4 font-sans text-sm leading-7 text-gray-700"
              data-testid="project-citation-source-excerpt"
            >
              {normalized.before}
              <mark
                className="rounded bg-amber-200 px-0.5 text-gray-950"
                data-testid="project-citation-highlight"
              >
                {normalized.quote}
              </mark>
              {normalized.after}
            </pre>
            <dl className="mt-5 divide-y divide-gray-100 text-xs">
              {normalized.snapshotId && (
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-2.5">
                  <dt className="text-gray-400">
                    {t("studio.sourceViewer.snapshot")}
                  </dt>
                  <dd
                    className="font-mono text-gray-600"
                    title={normalized.snapshotId}
                  >
                    {shortId(normalized.snapshotId)}
                  </dd>
                </div>
              )}
              {normalized.chunkId && (
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-2.5">
                  <dt className="text-gray-400">
                    {t("studio.sourceViewer.chunk")}
                  </dt>
                  <dd
                    className="font-mono text-gray-600"
                    title={normalized.chunkId}
                  >
                    {shortId(normalized.chunkId)}
                  </dd>
                </div>
              )}
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-2.5">
                <dt className="text-gray-400">
                  {t("studio.sourceViewer.version")}
                </dt>
                <dd
                  className="font-mono text-gray-600"
                  title={normalized.versionId}
                >
                  {shortId(normalized.versionId)}
                </dd>
              </div>
            </dl>
          </aside>
        </div>
      </section>
    </div>
  );
}
