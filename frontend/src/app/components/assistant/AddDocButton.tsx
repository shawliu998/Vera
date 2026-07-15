"use client";

// Direct UI port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/assistant/AddDocButton.tsx
import { Plus } from "lucide-react";
import { useI18n } from "@/app/i18n";

export function AddDocButton({
  onBrowseAll,
  selectedCount = 0,
}: {
  onBrowseAll: () => void;
  selectedCount?: number;
}) {
  const { t } = useI18n();

  return (
    <button
      type="button"
      onClick={onBrowseAll}
      className={`flex h-8 items-center gap-1 rounded-lg px-2 text-sm transition-colors ${
        selectedCount > 0
          ? "text-black hover:bg-white/55"
          : "text-gray-400 hover:bg-white/55 hover:text-gray-700"
      }`}
      title={t("assistant.documents.add")}
      aria-label={t("assistant.documents.add")}
    >
      {selectedCount > 0 ? (
        <span className="font-medium tabular-nums">{selectedCount}</span>
      ) : (
        <Plus className="h-4 w-4 shrink-0" />
      )}
      <span className="hidden sm:inline">{t("assistant.documents.label")}</span>
    </button>
  );
}
