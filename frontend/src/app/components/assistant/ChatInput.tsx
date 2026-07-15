"use client";

// Local Vera adaptation of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/assistant/ChatInput.tsx
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowRight, Loader2, Settings, Square, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useVeraSettings } from "@/app/contexts/VeraSettingsContext";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import type { Message } from "@/app/components/shared/types";
import type { VeraDocumentWire } from "@/app/lib/veraWireTypes";
import { useI18n } from "@/app/i18n";
import { AddDocButton } from "./AddDocButton";
import { AssistantDocumentPicker } from "./AssistantDocumentPicker";
import { ModelToggle } from "./ModelToggle";

export interface ChatInputHandle {
  addDoc: (document: VeraDocumentWire) => void;
  focus: () => void;
}

interface Props {
  onSubmit: (message: Message) => void | Promise<unknown>;
  onCancel: () => void | Promise<void>;
  isLoading: boolean;
  availableDocuments?: readonly VeraDocumentWire[];
  hideAddDocButton?: boolean;
  projectName?: string | null;
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
  {
    onSubmit,
    onCancel,
    isLoading,
    availableDocuments,
    hideAddDocButton = false,
    projectName,
  },
  ref,
) {
  const router = useRouter();
  const { t } = useI18n();
  const { settings, models, loadState } = useVeraSettings();
  const selectableModels = useMemo(
    () => models.filter((profile) => profile.availability.selectable),
    [models],
  );
  const preferredModelId =
    selectableModels.find(
      (profile) => profile.id === settings?.default_model_profile_id,
    )?.id ?? selectableModels[0]?.id ?? "";
  const [modelId, setModelId] = useState(preferredModelId);
  const [value, setValue] = useState("");
  const [attachedDocs, setAttachedDocs] = useState<VeraDocumentWire[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (!selectableModels.some((profile) => profile.id === modelId)) {
      setModelId(preferredModelId);
    }
  }, [modelId, preferredModelId, selectableModels]);

  useImperativeHandle(ref, () => ({
    addDoc(document) {
      if (document.status !== "ready") return;
      setAttachedDocs((current) =>
        current.some((item) => item.id === document.id)
          ? current
          : [...current, document],
      );
    },
    focus() {
      textareaRef.current?.focus();
    },
  }));

  const resize = (element: HTMLTextAreaElement) => {
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 192)}px`;
  };

  const submit = async () => {
    const prompt = value.trim();
    if (!prompt || !modelId || isLoading || submittingRef.current) return;
    const message: Message = {
      role: "user",
      content: prompt,
      model: modelId,
      ...(attachedDocs.length
        ? {
            files: attachedDocs.map((document) => ({
              filename: document.filename,
              document_id: document.id,
            })),
          }
        : {}),
    };
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const result = await onSubmit(message);
      if (!result) return;
      setValue("");
      setAttachedDocs([]);
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const selectedIds = useMemo(
    () => new Set(attachedDocs.map((document) => document.id)),
    [attachedDocs],
  );
  const modelUnavailable = loadState !== "loading" && selectableModels.length === 0;

  return (
    <>
      <div className="w-full">
        <div className="rounded-[18px] border border-white/65 bg-white/60 shadow-[0_4px_10px_rgba(15,23,42,0.12),inset_0_1px_0_rgba(255,255,255,0.85),inset_0_-6px_14px_rgba(255,255,255,0.18)] backdrop-blur-2xl md:rounded-[22px]">
          {attachedDocs.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-2 pt-2">
              {attachedDocs.map((document) => (
                <div
                  key={document.id}
                  className="inline-flex items-center gap-1 rounded-[10px] border border-white/70 bg-white py-0.5 pl-2 pr-1 text-xs text-gray-800 shadow-[0_2px_6px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-xl"
                >
                  <FileTypeIcon
                    fileType={document.file_type}
                    className="h-2.5 w-2.5"
                  />
                  <span className="max-w-[160px] truncate">
                    {document.filename}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setAttachedDocs((current) =>
                        current.filter((item) => item.id !== document.id),
                      )
                    }
                    className="ml-0.5 rounded-full p-0.5 text-gray-400 transition-colors hover:bg-gray-900/5 hover:text-gray-700"
                    aria-label={t("assistant.documents.remove", {
                      filename: document.filename,
                    })}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="px-4 pt-4">
            <textarea
              ref={textareaRef}
              rows={1}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                resize(event.target);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={
                modelUnavailable
                  ? t("assistant.input.modelRequired")
                  : projectName
                    ? t("assistant.input.projectPlaceholder", {
                        project: projectName,
                      })
                    : t("assistant.placeholder")
              }
              disabled={modelUnavailable}
              className="max-h-48 w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-base leading-6 text-gray-900 outline-none placeholder:text-gray-400 disabled:cursor-not-allowed"
            />
          </div>

          <div className="flex items-center justify-between p-2 md:p-2.5">
            <div className="flex min-w-0 items-center gap-1">
              {!hideAddDocButton && (
                <AddDocButton
                  onBrowseAll={() => setPickerOpen(true)}
                  selectedCount={attachedDocs.length}
                />
              )}
              {modelUnavailable && (
                <button
                  type="button"
                  onClick={() => router.push("/settings/models")}
                  className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-amber-700 transition-colors hover:bg-amber-50"
                >
                  <Settings className="h-3.5 w-3.5" />
                  {t("assistant.input.modelSettings")}
                </button>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <ModelToggle value={modelId} onChange={setModelId} />
              <button
                type="button"
                className={cn(
                  "relative flex h-8 w-8 items-center justify-center rounded-[10px] border border-white/30 bg-gradient-to-b from-neutral-700 to-black text-white shadow-[0_5px_14px_rgba(15,23,42,0.18),inset_0_1px_0_rgba(255,255,255,0.24)] transition-all active:enabled:scale-95 disabled:cursor-default disabled:opacity-40",
                )}
                onClick={() =>
                  isLoading ? void onCancel() : void submit()
                }
                disabled={
                  !isLoading &&
                  (submitting || !value.trim() || !modelId)
                }
                aria-label={
                  isLoading ? t("assistant.stop") : t("assistant.send")
                }
                title={isLoading ? t("assistant.stop") : t("assistant.send")}
              >
                {isLoading ? (
                  <Square className="h-3.5 w-3.5" fill="currentColor" strokeWidth={0} />
                ) : submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowRight className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      <AssistantDocumentPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        documents={availableDocuments}
        selectedIds={selectedIds}
        title={
          projectName
            ? t("assistant.documents.projectTitle", { project: projectName })
            : t("assistant.documents.assistantTitle")
        }
        onSelect={setAttachedDocs}
      />
    </>
  );
});
