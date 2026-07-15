"use client";

// Direct page composition port of Mike
// e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/(pages)/assistant/page.tsx
import { useRouter } from "next/navigation";
import { InitialView } from "@/app/components/assistant/InitialView";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import type { Message } from "@/app/components/shared/types";
import { VeraApiError } from "@/app/lib/veraApi";
import { useI18n } from "@/app/i18n";

export default function AssistantPage() {
  const router = useRouter();
  const { errorMessage } = useI18n();
  const { handleChat, streamError } = useAssistantChat();

  const submit = async (message: Message) => {
    const id = await handleChat(message);
    if (id) router.push(`/assistant/chat/${id}`);
    return id;
  };

  const visibleError = streamError
    ? errorMessage(
        streamError instanceof VeraApiError
          ? streamError
          : { code: "NETWORK_ERROR" },
      )
    : null;

  return <InitialView onSubmit={submit} error={visibleError} />;
}
