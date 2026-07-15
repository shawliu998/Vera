"use client";

// Durable history page port of Mike
// e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/(pages)/assistant/chat/[id]/page.tsx
import { use, useEffect } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { ChatView } from "@/app/components/assistant/ChatView";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { VeraApiError } from "@/app/lib/veraApi";
import { useI18n } from "@/app/i18n";

export default function AssistantChatPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { errorMessage, t } = useI18n();
  const assistant = useAssistantChat({ chatId: id });

  useEffect(() => {
    if (assistant.chat?.project_id) {
      router.replace(
        `/projects/${assistant.chat.project_id}/assistant/chat/${assistant.chat.id}`,
      );
    }
  }, [assistant.chat, router]);

  if (assistant.loadState === "loading" || assistant.chat?.project_id) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("assistant.restoring")}
      </div>
    );
  }

  if (assistant.loadState === "error") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-white/70 bg-white/65 p-6 text-center shadow-lg backdrop-blur-xl">
          <AlertCircle className="mx-auto h-6 w-6 text-red-500" />
          <p role="alert" className="mt-3 text-sm text-gray-700">
            {errorMessage(
              assistant.loadError instanceof VeraApiError
                ? assistant.loadError
                : { code: "NETWORK_ERROR" },
            )}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <button
              type="button"
              onClick={assistant.reload}
              className="rounded-full bg-gray-900 px-4 py-1.5 text-xs font-medium text-white"
            >
              {t("common.actions.retry")}
            </button>
            <button
              type="button"
              onClick={() => router.replace("/assistant")}
              className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-medium text-gray-700"
            >
              {t("assistant.newChat")}
            </button>
          </div>
        </div>
      </div>
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
    <ChatView
      messages={assistant.messages}
      isResponseLoading={assistant.isResponseLoading}
      handleChat={assistant.handleChat}
      cancel={assistant.cancel}
      retry={assistant.retry}
      regenerate={assistant.regenerate}
      resume={assistant.resume}
      streamError={streamError}
    />
  );
}
