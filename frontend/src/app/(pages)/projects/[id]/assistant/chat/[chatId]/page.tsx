"use client";

// Local P0 page port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/(pages)/projects/[id]/assistant/chat/[chatId]/page.tsx
import { use, useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { ChatView } from "@/app/components/assistant/ChatView";
import { ProjectExplorer } from "@/app/components/projects/ProjectExplorer";
import {
  ProjectSectionToolbar,
  useProjectWorkspace,
} from "@/app/components/projects/ProjectWorkspace";
import { useSidebar } from "@/app/contexts/SidebarContext";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { VeraApiError } from "@/app/lib/veraApi";
import type { VeraDocumentWire } from "@/app/lib/veraWireTypes";
import { useI18n } from "@/app/i18n";

export default function ProjectAssistantChatPage({
  params,
}: {
  params: Promise<{ id: string; chatId: string }>;
}) {
  const { id: projectId, chatId } = use(params);
  const router = useRouter();
  const { errorMessage, t } = useI18n();
  const { setSidebarOpen } = useSidebar();
  const workspace = useProjectWorkspace();
  const assistant = useAssistantChat({ chatId, projectId });
  const [selectedDocument, setSelectedDocument] =
    useState<VeraDocumentWire | null>(null);

  useEffect(() => {
    setSidebarOpen(false);
  }, [setSidebarOpen]);

  const wrongProject =
    assistant.chat && assistant.chat.project_id !== projectId;

  if (assistant.loadState === "loading") {
    return (
      <>
        <ProjectSectionToolbar />
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("assistant.project.restoring")}
        </div>
      </>
    );
  }

  if (assistant.loadState === "error" || wrongProject) {
    return (
      <>
        <ProjectSectionToolbar />
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="max-w-md rounded-2xl border border-white/70 bg-white/65 p-6 text-center shadow-lg backdrop-blur-xl">
            <AlertCircle className="mx-auto h-6 w-6 text-red-500" />
            <p role="alert" className="mt-3 text-sm text-gray-700">
              {wrongProject
                ? t("assistant.project.wrongScope")
                : errorMessage(
                    assistant.loadError instanceof VeraApiError
                      ? assistant.loadError
                      : { code: "NETWORK_ERROR" },
                  )}
            </p>
            <div className="mt-4 flex justify-center gap-2">
              {!wrongProject && (
                <button
                  type="button"
                  onClick={assistant.reload}
                  className="rounded-full bg-gray-900 px-4 py-1.5 text-xs font-medium text-white"
                >
                  {t("common.actions.retry")}
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  router.replace(`/projects/${projectId}/assistant`)
                }
                className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-medium text-gray-700"
              >
                {t("assistant.project.backToChats")}
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  const streamError = assistant.streamError
    ? errorMessage(
        assistant.streamError instanceof VeraApiError
          ? assistant.streamError
          : { code: "NETWORK_ERROR" },
      )
    : null;

  return (
    <>
      <ProjectSectionToolbar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="hidden w-72 shrink-0 border-r border-gray-200 bg-white/35 lg:flex lg:flex-col">
          <div className="border-b border-gray-200 px-4 py-2 text-xs font-medium text-gray-500">
            {t("assistant.project.documentsHint")}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-2">
            <ProjectExplorer
              projectName={workspace.project?.name}
              documents={workspace.documents}
              folders={workspace.folders}
              selectedDocId={selectedDocument?.id}
              onDocClick={(document) => setSelectedDocument({ ...document })}
            />
          </div>
        </aside>
        <div className="min-w-0 flex-1">
          <ChatView
            messages={assistant.messages}
            isResponseLoading={assistant.isResponseLoading}
            handleChat={assistant.handleChat}
            cancel={assistant.cancel}
            retry={assistant.retry}
            regenerate={assistant.regenerate}
            resume={assistant.resume}
            streamError={streamError}
            availableDocuments={workspace.documents}
            projectName={workspace.project?.name}
            documentToAttach={selectedDocument}
            projectId={projectId}
            chatId={chatId}
          />
        </div>
      </div>
    </>
  );
}
