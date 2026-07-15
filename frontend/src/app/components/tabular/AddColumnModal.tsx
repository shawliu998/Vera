"use client";

// Adapted from Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/tabular/AddColumnModal.tsx
import { useEffect, useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import { Modal } from "@/app/components/shared/Modal";
import { useI18n } from "@/app/i18n";
import type {
  VeraTabularColumn,
  VeraTabularFormat,
} from "@/app/lib/veraTabularApi";
import { FORMAT_OPTIONS } from "./columnFormat";
import { TAG_COLORS } from "./pillUtils";

type ColumnDraft = {
  name: string;
  prompt: string;
  format: VeraTabularFormat;
  tagsText: string;
};

const emptyDraft = (): ColumnDraft => ({
  name: "",
  prompt: "",
  format: "text",
  tagsText: "",
});

function draftFor(column: VeraTabularColumn): ColumnDraft {
  return {
    name: column.name,
    prompt: column.prompt,
    format: column.format,
    tagsText: column.tags.join(", "),
  };
}

function tagsFor(draft: ColumnDraft): string[] {
  if (draft.format !== "tag") return [];
  return [...new Set(draft.tagsText.split(",").map((tag) => tag.trim()).filter(Boolean))];
}

export function AddColumnModal({
  open,
  nextIndex,
  maxColumns = 100,
  editingColumn,
  busy = false,
  onClose,
  onAdd,
  onSave,
  onDelete,
}: {
  open: boolean;
  nextIndex: number;
  maxColumns?: number;
  editingColumn?: VeraTabularColumn;
  busy?: boolean;
  onClose: () => void;
  onAdd: (columns: VeraTabularColumn[]) => Promise<void> | void;
  onSave?: (column: VeraTabularColumn) => Promise<void> | void;
  onDelete?: (columnIndex: number) => Promise<void> | void;
}) {
  const { t, errorMessage } = useI18n();
  const [drafts, setDrafts] = useState<ColumnDraft[]>([emptyDraft()]);
  const [collapsed, setCollapsed] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = editingColumn !== undefined;
  const formId = editing ? "vera-edit-tabular-column" : "vera-add-tabular-columns";

  useEffect(() => {
    if (!open) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setDrafts(editingColumn ? [draftFor(editingColumn)] : [emptyDraft()]);
      setCollapsed([]);
      setSubmitting(false);
      setError(null);
    });
    return () => {
      active = false;
    };
  }, [editingColumn, open]);

  const invalid = drafts.length > maxColumns || drafts.some((draft) => {
    const tags = tagsFor(draft);
    return (
      !draft.name.trim() ||
      !draft.prompt.trim() ||
      draft.name.trim().length > 240 ||
      draft.prompt.length > 20_000 ||
      (draft.format === "tag" && tags.length === 0) ||
      tags.length > 100 ||
      tags.some((tag) => tag.length > 160)
    );
  });

  const update = (index: number, patch: Partial<ColumnDraft>) => {
    setDrafts((current) =>
      current.map((draft, position) =>
        position === index ? { ...draft, ...patch } : draft,
      ),
    );
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (invalid || submitting || busy) return;
    setSubmitting(true);
    setError(null);
    try {
      const columns = drafts.map((draft, offset): VeraTabularColumn => ({
        index: editingColumn?.index ?? nextIndex + offset,
        name: draft.name.trim(),
        prompt: draft.prompt.trim(),
        format: draft.format,
        tags: tagsFor(draft),
      }));
      if (editingColumn && onSave) await onSave(columns[0]!);
      else await onAdd(columns);
      onClose();
    } catch (reason) {
      setError(errorMessage(reason as Error));
    } finally {
      setSubmitting(false);
    }
  };

  const deleteColumn = async () => {
    if (!editingColumn || !onDelete || submitting || busy) return;
    setSubmitting(true);
    setError(null);
    try {
      await onDelete(editingColumn.index);
      onClose();
    } catch (reason) {
      setError(errorMessage(reason as Error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!submitting && !busy) onClose();
      }}
      breadcrumbs={[
        t("tabular.title"),
        editing ? t("tabular.columns.edit") : t("tabular.columns.add"),
      ]}
      primaryAction={{
        label: editing
          ? t("common.actions.save")
          : t("tabular.columns.addAction"),
        type: "submit",
        form: formId,
        disabled: invalid || submitting || busy,
      }}
      cancelAction={{
        label: t("common.actions.cancel"),
        onClick: onClose,
        disabled: submitting || busy,
      }}
      secondaryAction={
        editingColumn && onDelete
          ? {
              label: t("common.actions.delete"),
              variant: "danger",
              onClick: () => void deleteColumn(),
              disabled: submitting || busy,
            }
          : undefined
      }
    >
      <form id={formId} onSubmit={(event) => void submit(event)} className="space-y-5 pb-4">
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        )}
        {drafts.map((draft, index) => {
          const isCollapsed = collapsed.includes(index);
          const formatId = `vera-tabular-column-${index}-format`;
          return (
            <section key={index} className="rounded-2xl border border-white/70 bg-gray-50/70 p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() =>
                    setCollapsed((current) =>
                      current.includes(index)
                        ? current.filter((item) => item !== index)
                        : [...current, index],
                    )
                  }
                  aria-expanded={!isCollapsed}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-gray-500 transition-transform ${
                      isCollapsed ? "-rotate-90" : ""
                    }`}
                  />
                  <span className="truncate font-serif text-xl text-gray-950">
                    {draft.name.trim() || t("tabular.columns.ordinal", { index: index + 1 })}
                  </span>
                </button>
                {!editing && drafts.length > 1 && (
                  <button
                    type="button"
                    onClick={() =>
                      setDrafts((current) =>
                        current.filter((_, position) => position !== index),
                      )
                    }
                    aria-label={t("tabular.columns.remove")}
                    className="rounded-lg p-1.5 text-gray-400 hover:bg-white hover:text-gray-700"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>

              {!isCollapsed && (
                <div className="mt-4 space-y-4">
                  <label className="block space-y-1.5 text-xs font-medium text-gray-700">
                    <span>{t("tabular.columns.name")}</span>
                    <input
                      autoFocus={index === 0}
                      value={draft.name}
                      maxLength={240}
                      onChange={(event) => update(index, { name: event.target.value })}
                      placeholder={t("tabular.columns.namePlaceholder")}
                      className="w-full rounded-xl border border-white/80 bg-white/75 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-300"
                    />
                  </label>

                  <label htmlFor={formatId} className="block space-y-1.5 text-xs font-medium text-gray-700">
                    <span>{t("tabular.columns.format")}</span>
                    <select
                      id={formatId}
                      value={draft.format}
                      onChange={(event) =>
                        update(index, {
                          format: event.target.value as VeraTabularFormat,
                          tagsText:
                            event.target.value === "tag" ? draft.tagsText : "",
                        })
                      }
                      className="w-full rounded-xl border border-white/80 bg-white/75 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-300"
                    >
                      {FORMAT_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {t(option.labelKey)}
                        </option>
                      ))}
                    </select>
                  </label>

                  {draft.format === "tag" && (
                    <label className="block space-y-1.5 text-xs font-medium text-gray-700">
                      <span>{t("tabular.columns.tags")}</span>
                      <input
                        value={draft.tagsText}
                        onChange={(event) => update(index, { tagsText: event.target.value })}
                        placeholder={t("tabular.columns.tagsPlaceholder")}
                        className="w-full rounded-xl border border-white/80 bg-white/75 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-300"
                      />
                      <span className="flex flex-wrap gap-1">
                        {tagsFor(draft).map((tag, tagIndex) => (
                          <span
                            key={tag}
                            className={`rounded-full px-2 py-0.5 text-[10px] ${TAG_COLORS[tagIndex % TAG_COLORS.length]}`}
                          >
                            {tag}
                          </span>
                        ))}
                      </span>
                    </label>
                  )}

                  <label className="block space-y-1.5 text-xs font-medium text-gray-700">
                    <span>{t("tabular.columns.prompt")}</span>
                    <textarea
                      value={draft.prompt}
                      maxLength={20_000}
                      rows={5}
                      onChange={(event) => update(index, { prompt: event.target.value })}
                      placeholder={t("tabular.columns.promptPlaceholder")}
                      className="w-full resize-y rounded-xl border border-white/80 bg-white/75 px-3 py-2 text-sm leading-relaxed text-gray-900 outline-none focus:border-gray-300"
                    />
                  </label>
                </div>
              )}
            </section>
          );
        })}

        {!editing && (
          <button
            type="button"
            onClick={() => setDrafts((current) => [...current, emptyDraft()])}
            disabled={drafts.length >= maxColumns}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-gray-950 disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("tabular.columns.addAnother")}
          </button>
        )}
      </form>
    </Modal>
  );
}
