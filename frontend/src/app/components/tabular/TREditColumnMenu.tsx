"use client";

// Adapted from Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/tabular/TREditColumnMenu.tsx
import { useState } from "react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { ConfirmPopup } from "@/app/components/shared/ConfirmPopup";
import { useI18n } from "@/app/i18n";
import type { VeraTabularColumn } from "@/app/lib/veraTabularApi";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function TREditColumnMenu({
  column,
  disabled = false,
  onEdit,
  onDelete,
}: {
  column: VeraTabularColumn;
  disabled?: boolean;
  onEdit: (column: VeraTabularColumn) => void;
  onDelete: (columnIndex: number) => Promise<void> | void;
}) {
  const { t, errorMessage } = useI18n();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await onDelete(column.index);
      setConfirmOpen(false);
    } catch (reason) {
      setError(errorMessage(reason as Error));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={t("tabular.columns.actions", { name: column.name })}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="z-[170] w-40 bg-white">
          <DropdownMenuItem
            onSelect={() => onEdit(column)}
            className="cursor-pointer text-xs"
          >
            <Pencil className="h-3.5 w-3.5" />
            {t("common.actions.edit")}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setConfirmOpen(true)}
            className="cursor-pointer text-xs text-red-600 focus:bg-red-50 focus:text-red-700"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("common.actions.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmPopup
        open={confirmOpen}
        title={t("tabular.columns.deleteTitle")}
        message={
          <div className="space-y-2">
            <p>{t("tabular.columns.deleteBody", { name: column.name })}</p>
            {error && <p role="alert" className="text-red-600">{error}</p>}
          </div>
        }
        confirmLabel={t("common.actions.delete")}
        confirmStatus={deleting ? "loading" : "idle"}
        cancelLabel={t("common.actions.cancel")}
        cancelDisabled={deleting}
        onCancel={() => {
          if (!deleting) {
            setConfirmOpen(false);
            setError(null);
          }
        }}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}
