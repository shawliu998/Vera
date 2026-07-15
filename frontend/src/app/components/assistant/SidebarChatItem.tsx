"use client";

// Local Vera adaptation of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/shared/SidebarChatItem.tsx
import { useEffect, useRef, useState } from "react";
import { Check, MoreHorizontal, Pencil, Trash2, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import type { VeraAssistantChat } from "@/app/lib/veraAssistantApi";
import { useI18n } from "@/app/i18n";

export function SidebarChatItem({
  chat,
  active,
  onSelect,
}: {
  chat: VeraAssistantChat;
  active: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const { renameChat, deleteChat } = useChatHistoryContext();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(chat.title ?? "");
  const [failure, setFailure] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.focus();
  }, [renaming]);

  const save = async () => {
    const next = title.trim();
    if (!next) return;
    setFailure(false);
    try {
      await renameChat(chat.id, next);
      setRenaming(false);
    } catch {
      setFailure(true);
    }
  };

  return (
    <div
      className={cn(
        "group relative flex min-h-9 w-full items-center rounded-md transition-colors",
        active ? "bg-gray-200/60" : "hover:bg-gray-100",
        failure && "ring-1 ring-red-200",
      )}
    >
      {renaming ? (
        <div className="flex w-full items-center px-2 py-1">
          <input
            ref={inputRef}
            value={title}
            maxLength={240}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
              if (event.key === "Escape") {
                setRenaming(false);
                setTitle(chat.title ?? "");
              }
            }}
            className="min-w-0 flex-1 rounded bg-white px-1 py-0.5 text-xs shadow-inner outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button type="button" onClick={() => void save()} className="ml-1 p-1 text-green-600">
            <Check className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => {
              setRenaming(false);
              setTitle(chat.title ?? "");
            }}
            className="ml-0.5 p-1 text-red-600"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={onSelect}
            className={`min-w-0 flex-1 truncate px-3 py-2 text-left text-xs ${
              active ? "text-gray-900" : "text-gray-700"
            }`}
            title={chat.title ?? t("assistant.untitled")}
          >
            {chat.project_id && (
              <span className="text-gray-400">
                {t("assistant.history.projectPrefix")}
              </span>
            )}
            {chat.title ?? t("assistant.untitled")}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={`mr-1 rounded-md p-1 text-gray-500 transition-all hover:bg-gray-200 hover:text-gray-900 ${
                  active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                }`}
                aria-label={t("assistant.history.actions")}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="z-[150]">
              <DropdownMenuItem
                onSelect={() => {
                  setTitle(chat.title ?? "");
                  setRenaming(true);
                }}
              >
                <Pencil className="mr-2 h-4 w-4" />
                {t("common.actions.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setFailure(false);
                  void deleteChat(chat.id).catch(() => setFailure(true));
                }}
                className="text-red-600 focus:text-red-600"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t("common.actions.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
}
