"use client";

// Local-only port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/projects/ProjectAssistantTable.tsx
import { MessageSquare } from "lucide-react";
import { RowActions } from "@/app/components/shared/RowActions";
import {
  SkeletonDot,
  SkeletonLine,
  TableBody,
  TableCell,
  TableEmptyState,
  TableHeaderCell,
  TableHeaderRow,
  TablePrimaryCell,
  TableRow,
  TableScrollArea,
  TABLE_CHECKBOX_CLASS,
  TABLE_STICKY_CELL_BG,
} from "@/app/components/shared/TablePrimitive";
import type { VeraAssistantChat } from "@/app/lib/veraAssistantApi";
import { useI18n } from "@/app/i18n";

export function ProjectAssistantTable({
  chats,
  selectedIds,
  loading,
  renamingId,
  renameValue,
  onSelectedIdsChange,
  onOpen,
  onCreate,
  onDelete,
  onRenameStart,
  onRenameValueChange,
  onRenameCommit,
  onRenameCancel,
}: {
  chats: VeraAssistantChat[];
  selectedIds: string[];
  loading: boolean;
  renamingId: string | null;
  renameValue: string;
  onSelectedIdsChange: (ids: string[]) => void;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onDelete: (chat: VeraAssistantChat) => void | Promise<void>;
  onRenameStart: (chat: VeraAssistantChat) => void;
  onRenameValueChange: (value: string) => void;
  onRenameCommit: (chat: VeraAssistantChat) => void | Promise<void>;
  onRenameCancel: () => void;
}) {
  const { formatDate, t } = useI18n();
  const allSelected = chats.length > 0 && chats.every((chat) => selectedIds.includes(chat.id));
  const someSelected = !allSelected && chats.some((chat) => selectedIds.includes(chat.id));

  return (
    <TableScrollArea>
      <TableHeaderRow className="pr-8 md:pr-8">
        <div className={`sticky left-0 z-[60] flex h-full w-[248px] shrink-0 items-center gap-4 bg-[#fafbfc] pl-4 pr-2 sm:w-[292px] md:w-[332px]`}>
          {loading ? (
            <SkeletonDot />
          ) : (
            <input
              type="checkbox"
              checked={allSelected}
              ref={(element) => {
                if (element) element.indeterminate = someSelected;
              }}
              onChange={() =>
                onSelectedIdsChange(allSelected ? [] : chats.map((chat) => chat.id))
              }
              className={TABLE_CHECKBOX_CLASS}
              aria-label={t("assistant.table.selectAll")}
            />
          )}
          <span>{t("assistant.table.chat")}</span>
        </div>
        <TableHeaderCell className="ml-auto w-32">
          {t("common.fields.createdAt")}
        </TableHeaderCell>
        <TableHeaderCell className="w-8" />
      </TableHeaderRow>

      {loading ? (
        <TableBody>
          {[1, 2, 3, 4, 5].map((index) => (
            <TableRow key={index} interactive={false} className="pr-8 md:pr-8">
              <div className="sticky left-0 z-[60] flex w-[248px] shrink-0 items-center gap-4 bg-[#fafbfc] py-2 pl-4 pr-2 sm:w-[292px] md:w-[332px]">
                <SkeletonDot />
                <SkeletonLine className={`h-3.5 ${index % 2 ? "w-36" : "w-48"}`} />
              </div>
              <TableCell className="ml-auto w-32">
                <SkeletonLine className="w-16" />
              </TableCell>
              <TableCell className="w-8" />
            </TableRow>
          ))}
        </TableBody>
      ) : chats.length === 0 ? (
        <TableEmptyState>
          <MessageSquare className="mb-4 h-8 w-8 text-gray-300" />
          <p className="font-serif text-2xl font-medium text-gray-900">
            {t("assistant.title")}
          </p>
          <p className="mt-1 max-w-xs text-xs text-gray-400">
            {t("assistant.project.emptyBody")}
          </p>
          <button
            type="button"
            onClick={onCreate}
            className="mt-4 inline-flex items-center gap-1 rounded-full bg-gray-900 px-3 py-1 text-xs font-medium text-white shadow-md transition-colors hover:bg-gray-700"
          >
            + {t("assistant.newChat")}
          </button>
        </TableEmptyState>
      ) : (
        <TableBody>
          {chats.map((chat) => (
            <TableRow
              key={chat.id}
              onClick={() => {
                if (renamingId !== chat.id) onOpen(chat.id);
              }}
              className="pr-8 md:pr-8"
            >
              <TablePrimaryCell
                bgClassName={selectedIds.includes(chat.id) ? "bg-gray-50" : TABLE_STICKY_CELL_BG}
                selected={selectedIds.includes(chat.id)}
                onSelectionChange={() =>
                  onSelectedIdsChange(
                    selectedIds.includes(chat.id)
                      ? selectedIds.filter((id) => id !== chat.id)
                      : [...selectedIds, chat.id],
                  )
                }
                label={chat.title ?? t("assistant.untitled")}
                editing={renamingId === chat.id}
                editValue={renameValue}
                onEditValueChange={onRenameValueChange}
                onEditCommit={() => void onRenameCommit(chat)}
                onEditCancel={onRenameCancel}
              />
              <TableCell className="ml-auto w-32">
                {formatDate(chat.created_at, { dateStyle: "medium" })}
              </TableCell>
              <div className="flex w-8 shrink-0 justify-end" onClick={(event) => event.stopPropagation()}>
                <RowActions
                  onRename={() => onRenameStart(chat)}
                  onDelete={() => void onDelete(chat)}
                  renameLabel={t("common.actions.rename")}
                  deleteLabel={t("common.actions.delete")}
                />
              </div>
            </TableRow>
          ))}
        </TableBody>
      )}
    </TableScrollArea>
  );
}
