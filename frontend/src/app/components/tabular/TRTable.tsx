"use client";

// Adapted from Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/tabular/TRTable.tsx
import { ChevronLeft, ChevronRight, FilePlus2, Plus, Table2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/app/i18n";
import type { VeraDocumentWire } from "@/app/lib/veraWireTypes";
import type {
  VeraTabularCell,
  VeraTabularColumn,
} from "@/app/lib/veraTabularApi";
import { TABLE_CHECKBOX_CLASS } from "@/app/components/shared/TablePrimitive";
import { TabularCell } from "./TabularCell";
import { TREditColumnMenu } from "./TREditColumnMenu";

export const TABULAR_ROWS_PER_PAGE = 25;

export function tabularPageCount(rowCount: number): number {
  return Math.max(1, Math.ceil(Math.max(0, rowCount) / TABULAR_ROWS_PER_PAGE));
}

export function clampTabularPage(page: number, rowCount: number): number {
  return Math.min(Math.max(0, Math.trunc(page)), tabularPageCount(rowCount) - 1);
}

export function TRTable({
  loading,
  columns,
  documents,
  cells,
  selectedDocumentIds,
  disabled = false,
  canAddColumn = true,
  onSelectionChange,
  onOpenCell,
  onEditColumn,
  onDeleteColumn,
  onAddColumn,
  onAddDocuments,
}: {
  loading: boolean;
  columns: VeraTabularColumn[];
  documents: VeraDocumentWire[];
  cells: VeraTabularCell[];
  selectedDocumentIds: string[];
  disabled?: boolean;
  canAddColumn?: boolean;
  onSelectionChange: (ids: string[]) => void;
  onOpenCell: (cell: VeraTabularCell) => void;
  onEditColumn: (column: VeraTabularColumn) => void;
  onDeleteColumn: (columnIndex: number) => Promise<void> | void;
  onAddColumn: () => void;
  onAddDocuments: () => void;
}) {
  const { t } = useI18n();
  const [page, setPage] = useState(0);
  const sortedColumns = useMemo(
    () => [...columns].sort((left, right) => left.index - right.index),
    [columns],
  );
  const cellMap = useMemo(
    () =>
      new Map(
        cells.map((cell) => [
          `${cell.document_id}:${cell.column_index}`,
          cell,
        ]),
      ),
    [cells],
  );
  const pageCount = tabularPageCount(documents.length);
  const safePage = clampTabularPage(page, documents.length);
  const pageDocuments = documents.slice(
    safePage * TABULAR_ROWS_PER_PAGE,
    (safePage + 1) * TABULAR_ROWS_PER_PAGE,
  );
  const allPageSelected =
    pageDocuments.length > 0 &&
    pageDocuments.every((document) => selectedDocumentIds.includes(document.id));
  const somePageSelected =
    !allPageSelected &&
    pageDocuments.some((document) => selectedDocumentIds.includes(document.id));

  useEffect(() => {
    if (safePage !== page) queueMicrotask(() => setPage(safePage));
  }, [page, safePage]);

  if (!loading && (documents.length === 0 || columns.length === 0)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        <div className="flex max-w-sm flex-col items-center text-center">
          <Table2 className="h-8 w-8 text-gray-300" />
          <h2 className="mt-4 font-serif text-2xl text-gray-900">
            {documents.length === 0
              ? t("tabular.table.noDocuments")
              : t("tabular.table.noColumns")}
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-gray-500">
            {documents.length === 0
              ? t("tabular.table.noDocumentsBody")
              : t("tabular.table.noColumnsBody")}
          </p>
          <button
            type="button"
            onClick={documents.length === 0 ? onAddDocuments : onAddColumn}
            disabled={disabled || (documents.length > 0 && !canAddColumn)}
            className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-gray-950 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            {documents.length === 0 ? (
              <FilePlus2 className="h-3.5 w-3.5" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {documents.length === 0
              ? t("tabular.addDocuments")
              : t("tabular.addColumn")}
          </button>
        </div>
      </div>
    );
  }

  const totalWidth = 272 + sortedColumns.length * 288 + 48;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-auto">
        <div style={{ minWidth: totalWidth }}>
          <div className="sticky top-0 z-[70] flex h-9 border-b border-gray-200 bg-[#fafbfc] text-xs font-medium text-gray-500">
            <div className="sticky left-0 z-[80] flex w-[272px] shrink-0 items-center gap-4 border-r border-gray-200 bg-[#fafbfc] px-4">
              <input
                type="checkbox"
                checked={allPageSelected}
                ref={(element) => {
                  if (element) element.indeterminate = somePageSelected;
                }}
                onChange={() => {
                  const pageIds = new Set(pageDocuments.map((document) => document.id));
                  onSelectionChange(
                    allPageSelected
                      ? selectedDocumentIds.filter((id) => !pageIds.has(id))
                      : [...new Set([...selectedDocumentIds, ...pageIds])],
                  );
                }}
                className={TABLE_CHECKBOX_CLASS}
              />
              {t("documents.title")}
            </div>
            {sortedColumns.map((column) => (
              <div
                key={column.index}
                data-tr-col-header
                className="flex w-72 shrink-0 items-center justify-between gap-2 border-r border-gray-200 px-3"
              >
                <span className="truncate" title={column.name}>{column.name}</span>
                <TREditColumnMenu
                  column={column}
                  disabled={disabled}
                  onEdit={onEditColumn}
                  onDelete={onDeleteColumn}
                />
              </div>
            ))}
            <div className="flex w-12 shrink-0 items-center justify-center">
              <button
                type="button"
                onClick={onAddColumn}
                disabled={disabled || !canAddColumn}
                aria-label={t("tabular.addColumn")}
                title={!canAddColumn ? t("tabular.documents.matrixLimit") : undefined}
                className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-800 disabled:opacity-40"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </div>

          {loading ? (
            <div className="space-y-px">
              {Array.from({ length: 8 }, (_, index) => (
                <div key={index} className="flex h-11 border-b border-gray-100">
                  <div className="sticky left-0 z-[60] flex w-[272px] shrink-0 items-center gap-4 border-r border-gray-100 bg-[#fafbfc] px-4">
                    <span className="h-2.5 w-2.5 animate-pulse rounded bg-gray-100" />
                    <span className="h-3 w-36 animate-pulse rounded bg-gray-100" />
                  </div>
                  {sortedColumns.map((column) => (
                    <div key={column.index} className="flex w-72 shrink-0 items-center border-r border-gray-100 px-3">
                      <span className="h-3 w-32 animate-pulse rounded bg-gray-100" />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            pageDocuments.map((document, rowIndex) => {
              const selected = selectedDocumentIds.includes(document.id);
              const rowBackground = rowIndex % 2 === 0 ? "bg-[#fafbfc]" : "bg-gray-50";
              return (
                <div key={document.id} className={`flex h-11 border-b border-gray-100 ${rowBackground}`}>
                  <div className={`sticky left-0 z-[60] flex w-[272px] shrink-0 items-center gap-4 border-r border-gray-100 px-4 ${selected ? "bg-gray-100" : rowBackground}`}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() =>
                        onSelectionChange(
                          selected
                            ? selectedDocumentIds.filter((id) => id !== document.id)
                            : [...selectedDocumentIds, document.id],
                        )
                      }
                      className={TABLE_CHECKBOX_CLASS}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs text-gray-800" title={document.filename}>
                      {document.filename}
                    </span>
                  </div>
                  {sortedColumns.map((column) => {
                    const cell = cellMap.get(`${document.id}:${column.index}`);
                    return (
                      <div key={column.index} className="w-72 shrink-0 border-r border-gray-100">
                        {cell ? (
                          <TabularCell
                            cell={cell}
                            column={column}
                            onOpen={() => onOpenCell(cell)}
                          />
                        ) : (
                          <div className="h-11" />
                        )}
                      </div>
                    );
                  })}
                  <div className="w-12 shrink-0" />
                </div>
              );
            })
          )}
        </div>
      </div>

      {!loading && documents.length > TABULAR_ROWS_PER_PAGE && (
        <div className="flex h-10 shrink-0 items-center justify-between border-t border-gray-200 px-4 text-xs text-gray-500">
          <span>
            {t("tabular.table.pageRange", {
              start: safePage * TABULAR_ROWS_PER_PAGE + 1,
              end: Math.min((safePage + 1) * TABULAR_ROWS_PER_PAGE, documents.length),
              total: documents.length,
            })}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={safePage === 0}
              aria-label={t("tabular.table.previousPage")}
              className="rounded-md p-1.5 hover:bg-gray-100 disabled:opacity-30"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="min-w-16 text-center">
              {safePage + 1} / {pageCount}
            </span>
            <button
              type="button"
              onClick={() =>
                setPage((current) => Math.min(pageCount - 1, current + 1))
              }
              disabled={safePage >= pageCount - 1}
              aria-label={t("tabular.table.nextPage")}
              className="rounded-md p-1.5 hover:bg-gray-100 disabled:opacity-30"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
