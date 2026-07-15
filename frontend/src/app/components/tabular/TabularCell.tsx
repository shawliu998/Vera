"use client";

// Adapted from Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/tabular/TabularCell.tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle, Loader2, Quote } from "lucide-react";
import { useI18n } from "@/app/i18n";
import type {
  VeraTabularCell as VeraTabularCellRecord,
  VeraTabularColumn,
} from "@/app/lib/veraTabularApi";
import { getPillClass, parsePills } from "./pillUtils";

const FLAG_STYLES = {
  green: "bg-emerald-500",
  grey: "bg-slate-400",
  yellow: "bg-amber-400",
  red: "bg-red-500",
} as const;

function Summary({
  value,
  column,
}: {
  value: string;
  column: VeraTabularColumn;
}) {
  if (["tag", "yes_no", "currency"].includes(column.format)) {
    const segments = parsePills(value);
    const normalized =
      segments.some((segment) => segment.type === "pill")
        ? segments
        : [{ type: "pill" as const, content: value }];
    return (
      <span className="inline-flex max-w-full flex-wrap gap-1">
        {normalized.map((segment, index) =>
          segment.type === "pill" ? (
            <span
              key={`${segment.content}-${index}`}
              className={`max-w-full truncate rounded-full px-2 py-0.5 text-[10px] font-medium ${getPillClass(segment.content, column)}`}
            >
              {segment.content}
            </span>
          ) : (
            <span key={index}>{segment.content}</span>
          ),
        )}
      </span>
    );
  }
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <span>{children}</span>,
        ul: ({ children }) => <span>{children}</span>,
        ol: ({ children }) => <span>{children}</span>,
        li: ({ children }) => <span>{children} </span>,
        a: ({ children }) => <span>{children}</span>,
        img: ({ alt }) => <span>{alt ?? ""}</span>,
        code: ({ children }) => <span className="font-mono">{children}</span>,
      }}
    >
      {value.split("\n").find((line) => line.trim()) ?? value}
    </ReactMarkdown>
  );
}

export function TabularCell({
  cell,
  column,
  onOpen,
}: {
  cell: VeraTabularCellRecord;
  column: VeraTabularColumn;
  onOpen: () => void;
}) {
  const { t } = useI18n();

  if (cell.status === "generating") {
    return (
      <div className="flex h-11 items-center gap-2 px-3 text-xs text-gray-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("tabular.status.generating")}
      </div>
    );
  }

  if (cell.status === "error") {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="flex h-11 w-full items-center gap-2 px-3 text-left text-xs text-red-600 hover:bg-red-50/60"
        title={cell.error?.message}
      >
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{cell.error?.message ?? t("common.status.failed")}</span>
      </button>
    );
  }

  if (cell.status === "pending" || !cell.content) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="h-11 w-full px-3 text-left text-xs text-gray-300 hover:bg-gray-50"
      >
        {t("tabular.status.pending")}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative flex h-11 w-full items-center gap-1.5 overflow-hidden px-3 text-left text-xs text-gray-800 hover:bg-gray-50"
      aria-label={t("tabular.cell.open", { column: column.name })}
    >
      {cell.content.flag && (
        <span
          className={`absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ${FLAG_STYLES[cell.content.flag]}`}
          title={cell.content.flag}
        />
      )}
      <span className="min-w-0 flex-1 truncate">
        <Summary value={cell.content.summary} column={column} />
      </span>
      {cell.sources.length > 0 && (
        <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-[9px] text-gray-500">
          <Quote className="h-2.5 w-2.5" />
          {cell.sources.length}
        </span>
      )}
    </button>
  );
}
