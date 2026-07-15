"use client";

// Adapted from Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/tabular/TRSidePanel.tsx. Vera renders only the
// persisted source records returned by the local runtime.
import { ChevronLeft, ChevronRight, Loader2, RefreshCw, Square, Trash2, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "@/app/i18n";
import type { VeraDocumentWire } from "@/app/lib/veraWireTypes";
import type {
  VeraTabularCell,
  VeraTabularColumn,
} from "@/app/lib/veraTabularApi";
import {
  sourceIdentity,
  tabularSourceOffsetLabel,
  tabularSourcePageLabel,
} from "./citation-utils";

const FLAG_BADGE = {
  green: "bg-emerald-100 text-emerald-800",
  grey: "bg-slate-100 text-slate-700",
  yellow: "bg-amber-100 text-amber-800",
  red: "bg-red-100 text-red-800",
} as const;

function SafeMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children: label }) => <span>{label}</span>,
        img: ({ alt }) => <span>{alt ?? ""}</span>,
        p: ({ children: value }) => <p className="mb-2 last:mb-0">{value}</p>,
        ul: ({ children: value }) => <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{value}</ul>,
        ol: ({ children: value }) => <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{value}</ol>,
        code: ({ children: value }) => <code className="rounded bg-gray-100 px-1 font-mono text-[11px]">{value}</code>,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

export function TRSidePanel({
  cell,
  document,
  column,
  columns,
  busy = false,
  onClose,
  onNavigate,
  onRegenerate,
  onCancel,
  onClearDocument,
}: {
  cell: VeraTabularCell;
  document: VeraDocumentWire;
  column: VeraTabularColumn;
  columns: VeraTabularColumn[];
  busy?: boolean;
  onClose: () => void;
  onNavigate: (columnIndex: number) => void;
  onRegenerate: () => Promise<void> | void;
  onCancel: () => Promise<void> | void;
  onClearDocument: () => Promise<void> | void;
}) {
  const { t, formatDate } = useI18n();
  const ordered = [...columns].sort((left, right) => left.index - right.index);
  const position = ordered.findIndex((item) => item.index === column.index);
  const previous = position > 0 ? ordered[position - 1] : undefined;
  const next = position >= 0 && position < ordered.length - 1
    ? ordered[position + 1]
    : undefined;

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label={t("tabular.cell.details")}
      className="fixed bottom-3 right-3 top-3 z-[150] flex w-[min(92vw,390px)] flex-col overflow-hidden rounded-2xl border border-white/70 bg-white/94 shadow-[-8px_0_30px_rgba(15,23,42,0.12)] backdrop-blur-2xl"
    >
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-gray-100 px-4">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => previous && onNavigate(previous.index)}
            disabled={!previous}
            title={previous?.name}
            className="rounded-md p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-12 text-center text-xs tabular-nums text-gray-500">
            {position + 1} / {ordered.length}
          </span>
          <button
            type="button"
            onClick={() => next && onNavigate(next.index)}
            disabled={!next}
            title={next?.name}
            className="rounded-md p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <span className="ml-auto rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-600">
          {t(`tabular.status.${cell.status}`)}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.actions.close")}
          className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-800"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <h2 className="font-serif text-xl text-gray-950">{column.name}</h2>
        <p className="mt-1 truncate text-xs text-gray-500" title={document.filename}>
          {document.filename}
        </p>

        {cell.content?.flag && (
          <span className={`mt-4 inline-flex rounded-full px-2.5 py-1 text-[10px] font-medium ${FLAG_BADGE[cell.content.flag]}`}>
            {t(`tabular.flags.${cell.content.flag}`)}
          </span>
        )}

        {cell.error && (
          <section className="mt-5 rounded-xl border border-red-100 bg-red-50 p-3">
            <h3 className="text-xs font-medium text-red-800">{cell.error.code}</h3>
            <p className="mt-1 text-xs leading-relaxed text-red-700">
              {cell.error.message}
            </p>
            <p className="mt-2 text-[10px] text-red-600">
              {cell.error.retryable
                ? t("tabular.cell.retryable")
                : t("tabular.cell.notRetryable")}
            </p>
          </section>
        )}

        <section className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            {t("tabular.cell.result")}
          </h3>
          <div className="mt-2 text-sm leading-relaxed text-gray-800">
            {cell.content?.summary ? (
              <SafeMarkdown>{cell.content.summary}</SafeMarkdown>
            ) : (
              <span className="text-gray-400">—</span>
            )}
          </div>
        </section>

        {cell.content?.reasoning && (
          <section className="mt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              {t("tabular.cell.reasoning")}
            </h3>
            <div className="mt-2 text-xs leading-relaxed text-gray-600">
              <SafeMarkdown>{cell.content.reasoning}</SafeMarkdown>
            </div>
          </section>
        )}

        <section className="mt-6">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            {t("tabular.cell.sources", { count: cell.sources.length })}
          </h3>
          {cell.sources.length === 0 ? (
            <p className="mt-2 text-xs text-gray-400">{t("tabular.cell.noSources")}</p>
          ) : (
            <div className="mt-2 space-y-2">
              {cell.sources.map((source, index) => {
                const page = tabularSourcePageLabel(source);
                const offsets = tabularSourceOffsetLabel(source);
                return (
                  <article
                    key={`${sourceIdentity(source)}:${index}`}
                    className="rounded-xl border border-gray-100 bg-gray-50/80 p-3"
                  >
                    <div className="flex items-center gap-2 text-[10px] font-medium text-gray-500">
                      <span>{t("tabular.cell.sourceOrdinal", { index: index + 1 })}</span>
                      {page && <span>{t("tabular.cell.page", { page })}</span>}
                      {offsets && <span>{t("tabular.cell.offsets", { offsets })}</span>}
                    </div>
                    {source.quote && (
                      <blockquote className="mt-2 border-l-2 border-gray-200 pl-2 text-xs leading-relaxed text-gray-700">
                        {source.quote}
                      </blockquote>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <dl className="mt-6 divide-y divide-gray-100 text-[11px] text-gray-500">
          <div className="flex justify-between gap-4 py-2">
            <dt>{t("tabular.cell.attempt")}</dt>
            <dd>{cell.attempt}</dd>
          </div>
          <div className="flex justify-between gap-4 py-2">
            <dt>{t("common.fields.updatedAt")}</dt>
            <dd>{formatDate(cell.updated_at)}</dd>
          </div>
        </dl>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-gray-100 p-3">
        <button
          type="button"
          onClick={() => void onClearDocument()}
          disabled={busy || cell.status === "generating"}
          className="inline-flex items-center gap-1.5 px-2 py-1.5 text-xs text-red-600 hover:text-red-800 disabled:opacity-40"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("tabular.cell.clearDocument")}
        </button>
        {cell.status === "generating" ? (
          <button
            type="button"
            onClick={() => void onCancel()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
            {t("tabular.cell.cancel")}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void onRegenerate()}
            disabled={busy || (cell.status === "error" && !cell.error?.retryable)}
            className="inline-flex items-center gap-1.5 rounded-full bg-gray-950 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {cell.status === "error" ? t("tabular.retryCell") : t("tabular.cell.regenerate")}
          </button>
        )}
      </footer>
    </aside>
  );
}
