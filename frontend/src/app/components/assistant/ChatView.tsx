"use client";

// Core message-column UI ported from Mike
// e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/assistant/ChatView.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, RefreshCw } from "lucide-react";
import type { Message } from "@/app/components/shared/types";
import type { VeraDocumentWire } from "@/app/lib/veraWireTypes";
import { AssistantMessage } from "./AssistantMessage";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { UserMessage } from "./UserMessage";
import { VeraMark } from "@/app/components/vera-brand";
import { useI18n } from "@/app/i18n";

const INPUT_BOTTOM_OFFSET = 12;
const INPUT_GAP = 16;
const MESSAGES_BOTTOM_PADDING = 116;

export function ChatView({
  messages,
  isResponseLoading,
  handleChat,
  cancel,
  retry,
  regenerate,
  resume,
  streamError,
  availableDocuments,
  projectName,
  documentToAttach,
  projectId,
  chatId,
}: {
  messages: Message[];
  isResponseLoading: boolean;
  handleChat: (message: Message) => Promise<string | null>;
  cancel: () => void | Promise<void>;
  retry: () => void | Promise<void>;
  regenerate: () => void | Promise<void>;
  resume: () => void;
  streamError?: string | null;
  availableDocuments?: readonly VeraDocumentWire[];
  projectName?: string | null;
  documentToAttach?: VeraDocumentWire | null;
  projectId?: string;
  chatId?: string;
}) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const latestUserRef = useRef<HTMLDivElement>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<ChatInputHandle>(null);
  const [inputHeight, setInputHeight] = useState(0);
  const [showScrollButton, setShowScrollButton] = useState(false);

  useEffect(() => {
    const input = inputContainerRef.current;
    if (!input) return;
    const observer = new ResizeObserver(() =>
      setInputHeight(input.offsetHeight),
    );
    observer.observe(input);
    setInputHeight(input.offsetHeight);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (documentToAttach) chatInputRef.current?.addDoc(documentToAttach);
  }, [documentToAttach]);

  const updateScrollButton = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const distance =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    setShowScrollButton(distance > 24);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener("scroll", updateScrollButton);
    updateScrollButton();
    return () => container.removeEventListener("scroll", updateScrollButton);
  }, [messages, updateScrollButton]);

  useEffect(() => {
    const last = messages.at(-1);
    if (last?.role !== "user" && !isResponseLoading) return;
    const frame = window.requestAnimationFrame(() => {
      const container = containerRef.current;
      const target = latestUserRef.current;
      if (!container || !target) return;
      container.scrollTo({
        top: Math.max(0, target.offsetTop - 24),
        behavior: "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isResponseLoading, messages]);

  const latestUserIndex = messages
    .map((message) => message.role)
    .lastIndexOf("user");
  const latestAssistantIndex = messages
    .map((message) => message.role)
    .lastIndexOf("assistant");

  return (
    <div className="relative flex h-full w-full min-w-0 flex-col">
      <div
        ref={containerRef}
        className="min-h-0 w-full flex-1 overflow-y-auto"
        style={{ scrollbarGutter: "stable both-edges" }}
      >
        <div
          className="relative mx-auto flex min-h-full w-full max-w-4xl flex-col px-6 pt-6 md:px-8 md:pt-8"
          style={{ paddingBottom: MESSAGES_BOTTOM_PADDING }}
        >
          <div className="space-y-6 md:space-y-8">
            {messages.length === 0 && (
              <div className="flex min-h-[55dvh] items-center justify-center gap-3 text-gray-900">
                <VeraMark size={28} decorative />
                <p className="font-serif text-3xl font-light">
                  {projectName ?? t("assistant.empty.title")}
                </p>
              </div>
            )}
            {messages.map((message, index) => (
              <div
                key={message.id ?? `${message.role}-${index}`}
                ref={index === latestUserIndex ? latestUserRef : undefined}
              >
                {message.role === "user" ? (
                  <UserMessage
                    content={message.content}
                    files={message.files}
                  />
                ) : (
                  <AssistantMessage
                    message={message}
                    isStreaming={
                      index === latestAssistantIndex && isResponseLoading
                    }
                    isLatest={index === latestAssistantIndex}
                    onRetry={retry}
                    onRegenerate={regenerate}
                    studioHandoff={
                      projectId && chatId ? { projectId, chatId } : undefined
                    }
                    citationScope={
                      projectId
                        ? {
                            projectId,
                            documentIds: (availableDocuments ?? []).map(
                              (document) => document.id,
                            ),
                          }
                        : undefined
                    }
                  />
                )}
              </div>
            ))}
            <div ref={endRef} />
          </div>
        </div>
      </div>

      {showScrollButton && (
        <div
          className="absolute left-1/2 z-20 -translate-x-1/2"
          style={{ bottom: inputHeight + INPUT_BOTTOM_OFFSET + INPUT_GAP }}
        >
          <button
            type="button"
            onClick={() =>
              endRef.current?.scrollIntoView({ behavior: "smooth" })
            }
            className="rounded-full bg-white/30 p-2 shadow-[0_5px_16px_rgba(15,23,42,0.13),inset_0_1px_0_rgba(255,255,255,0.75)] backdrop-blur-xl transition-all hover:bg-white/50"
            aria-label={t("assistant.scrollBottom")}
          >
            <ArrowDown className="h-5 w-5 text-gray-500" />
          </button>
        </div>
      )}

      <div className="absolute bottom-3 left-0 right-0 z-30 w-full">
        <div className="pointer-events-none absolute -bottom-3 left-0 right-0">
          <div className="mx-auto h-7 w-full max-w-4xl px-4 md:px-6">
            <div className="h-full rounded-t-[20px] bg-white/50 backdrop-blur-[1px]" />
          </div>
        </div>
        <div
          ref={inputContainerRef}
          className="relative mx-auto w-full max-w-4xl px-4 md:px-6"
        >
          {streamError && (
            <div
              role="alert"
              className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-red-100 bg-red-50/95 px-3 py-2 text-xs text-red-700 shadow-sm"
            >
              <span>{streamError}</span>
              <button
                type="button"
                onClick={resume}
                className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 font-medium hover:bg-red-100"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t("assistant.resume")}
              </button>
            </div>
          )}
          <ChatInput
            ref={chatInputRef}
            onSubmit={handleChat}
            onCancel={cancel}
            isLoading={isResponseLoading}
            availableDocuments={availableDocuments}
            projectName={projectName}
          />
        </div>
      </div>
    </div>
  );
}
