"use client";

// Local-only page port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/(pages)/projects/[id]/assistant/page.tsx
import { use, useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ChevronDown, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { ProjectAssistantTable } from "@/app/components/projects/ProjectAssistantTable";
import {
  ProjectSectionToolbar,
  useProjectWorkspace,
} from "@/app/components/projects/ProjectWorkspace";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useVeraSettings } from "@/app/contexts/VeraSettingsContext";
import {
  deleteVeraAssistantChat,
  listVeraProjectAssistantChats,
  renameVeraAssistantChat,
  type VeraAssistantChat,
} from "@/app/lib/veraAssistantApi";
import { VeraApiError } from "@/app/lib/veraApi";
import { useI18n } from "@/app/i18n";

export default function ProjectAssistantPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { errorMessage, t } = useI18n();
  const workspace = useProjectWorkspace();
  const { saveChat, loadChats } = useChatHistoryContext();
  const { settings, models } = useVeraSettings();
  const [chats, setChats] = useState<VeraAssistantChat[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<unknown>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [actionsOpen, setActionsOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setFailure(null);
      try {
        const next = await listVeraProjectAssistantChats(id, signal);
        if (!signal?.aborted) setChats(next);
      } catch (error) {
        if (!signal?.aborted) setFailure(error);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const filteredChats = useMemo(() => {
    const query = workspace.search.trim().toLocaleLowerCase();
    return query
      ? chats.filter((chat) =>
          (chat.title ?? "").toLocaleLowerCase().includes(query),
        )
      : chats;
  }, [chats, workspace.search]);

  const defaultModelId = models.find(
    (profile) =>
      profile.id === settings?.default_model_profile_id &&
      profile.availability.selectable,
  )?.id;

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setFailure(null);
    try {
      const chatId = await saveChat({
        projectId: id,
        ...(defaultModelId ? { modelProfileId: defaultModelId } : {}),
      });
      router.push(`/projects/${id}/assistant/chat/${chatId}`);
    } catch (error) {
      setFailure(error);
    } finally {
      setCreating(false);
    }
  };

  const commitRename = async (chat: VeraAssistantChat) => {
    const title = renameValue.trim();
    setRenamingId(null);
    if (!title || title === chat.title) return;
    setFailure(null);
    try {
      await renameVeraAssistantChat(chat.id, title);
      setChats((current) =>
        current.map((item) =>
          item.id === chat.id ? { ...item, title } : item,
        ),
      );
      await loadChats();
    } catch (error) {
      setFailure(error);
      await load();
    }
  };

  const remove = async (chat: VeraAssistantChat) => {
    setFailure(null);
    try {
      await deleteVeraAssistantChat(chat.id);
      setChats((current) => current.filter((item) => item.id !== chat.id));
      setSelectedIds((current) => current.filter((chatId) => chatId !== chat.id));
      await loadChats();
    } catch (error) {
      setFailure(error);
    }
  };

  const deleteSelected = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setActionsOpen(false);
    setFailure(null);
    const settled = await Promise.allSettled(ids.map(deleteVeraAssistantChat));
    const deleted = ids.filter((_, index) => settled[index]?.status === "fulfilled");
    setChats((current) => current.filter((chat) => !deleted.includes(chat.id)));
    setSelectedIds(ids.filter((id, index) => settled[index]?.status === "rejected"));
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) setFailure(rejected.reason);
    await loadChats();
  };

  return (
    <>
      <ProjectSectionToolbar
        actions={
          <div className="flex items-center gap-3">
            {creating && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
            {selectedIds.length > 0 && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setActionsOpen((open) => !open)}
                  className="flex items-center gap-1 text-xs font-medium text-gray-700 hover:text-gray-900"
                >
                  {t("assistant.selected.count", { count: selectedIds.length })}
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
                {actionsOpen && (
                  <div className="absolute right-0 top-full z-[120] mt-1 w-36 overflow-hidden rounded-lg border border-white/60 bg-white shadow-xl backdrop-blur-xl">
                    <button
                      type="button"
                      onClick={() => void deleteSelected()}
                      className="w-full px-3 py-2 text-left text-xs text-red-600 hover:bg-red-50"
                    >
                      {t("assistant.selected.delete")}
                    </button>
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              disabled={creating}
              onClick={() => void create()}
              className="rounded-full bg-gray-900 px-3 py-1 text-xs font-medium text-white shadow-md transition-colors hover:bg-gray-700 disabled:opacity-50"
            >
              + {t("assistant.newChat")}
            </button>
          </div>
        }
      />
      {failure && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700 md:px-10"
        >
          <span className="flex items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5" />
            {errorMessage(
              failure instanceof VeraApiError
                ? failure
                : { code: "NETWORK_ERROR" },
            )}
          </span>
          <button type="button" onClick={() => void load()} className="font-medium">
            {t("common.actions.retry")}
          </button>
        </div>
      )}
      <ProjectAssistantTable
        chats={filteredChats}
        selectedIds={selectedIds}
        loading={loading}
        renamingId={renamingId}
        renameValue={renameValue}
        onSelectedIdsChange={setSelectedIds}
        onOpen={(chatId) =>
          router.push(`/projects/${id}/assistant/chat/${chatId}`)
        }
        onCreate={() => void create()}
        onDelete={remove}
        onRenameStart={(chat) => {
          setRenamingId(chat.id);
          setRenameValue(chat.title ?? t("assistant.untitled"));
        }}
        onRenameValueChange={setRenameValue}
        onRenameCommit={commitRename}
        onRenameCancel={() => setRenamingId(null)}
      />
    </>
  );
}
