"use client";

// Local P0 rendering port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/assistant/AssistantMessage.tsx and its message/*
// children. Cloud connectors, case-law browsing, and document editing blocks
// are intentionally omitted; durable local reasoning, document reads/finds,
// citations, completion, retry, and regeneration remain real.
import { useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  FileSearch,
  FileText,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Wrench,
} from "lucide-react";
import type {
  AssistantEvent,
  CitationAnnotation,
  Message,
} from "@/app/components/shared/types";
import {
  displayCitationQuote,
  getDocumentCitationQuotes,
} from "@/app/components/shared/types";
import { useI18n, type MessageKey, type Translate } from "@/app/i18n";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { ResponseStatus } from "./ResponseStatus";

const TOOL_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  list_documents: "assistant.events.listDocuments",
  read_document: "assistant.events.readDocument",
  fetch_documents: "assistant.events.fetchDocuments",
  find_in_document: "assistant.events.findInDocument",
  list_workflows: "assistant.events.listWorkflows",
  read_workflow: "assistant.events.readWorkflow",
};

function preEventLabel(event: AssistantEvent, t: Translate): {
  icon: React.ReactNode;
  title: string;
  detail?: string;
  active?: boolean;
} | null {
  switch (event.type) {
    case "status":
      return {
        icon: <Loader2 className="h-3.5 w-3.5" />,
        title:
          event.status === "retrying"
            ? t("assistant.events.retrying")
            : event.status === "queued"
              ? t("assistant.events.queued")
              : t("assistant.events.generating"),
        active: true,
      };
    case "reasoning":
      return {
        icon: <ChevronDown className="h-3.5 w-3.5" />,
        title: t("assistant.events.reasoning"),
        detail: event.text,
        active: event.isStreaming,
      };
    case "tool_call_start":
      return {
        icon: <Wrench className="h-3.5 w-3.5" />,
        title: t(
          TOOL_LABEL_KEYS[event.name] ?? "assistant.events.localTool",
        ),
        active: event.isStreaming,
      };
    case "doc_read_start":
      return {
        icon: <FileText className="h-3.5 w-3.5" />,
        title: t("assistant.events.readingDocument", {
          filename: event.filename,
        }),
        active: true,
      };
    case "doc_read":
      return {
        icon: <FileText className="h-3.5 w-3.5" />,
        title: t("assistant.events.documentRead", {
          filename: event.filename,
        }),
      };
    case "doc_find_start":
      return {
        icon: <Search className="h-3.5 w-3.5" />,
        title: t("assistant.events.findingDocument", {
          filename: event.filename,
        }),
        detail: event.query,
        active: true,
      };
    case "doc_find":
      return {
        icon: <FileSearch className="h-3.5 w-3.5" />,
        title: t("assistant.events.matches", {
          filename: event.filename,
          count: event.total_matches,
        }),
        detail: event.query,
      };
    case "workflow_applied":
      return {
        icon: <Wrench className="h-3.5 w-3.5" />,
        title: t("assistant.events.workflowApplied", { title: event.title }),
      };
    case "thinking":
      return {
        icon: <Loader2 className="h-3.5 w-3.5" />,
        title: t("assistant.events.thinking"),
        active: true,
      };
    default:
      return null;
  }
}

function citationLocation(
  citation: CitationAnnotation,
  t: Translate,
): string {
  if (citation.kind === "case") {
    return (
      citation.citation ||
      citation.case_name ||
      t("assistant.caseFallback", {
        id: String(citation.cluster_id ?? "—"),
      })
    );
  }
  const quotes = getDocumentCitationQuotes(citation);
  const pages = Array.from(
    new Set(quotes.map((quote) => String(quote.page)).filter(Boolean)),
  );
  if (pages.length > 1) {
    return t("assistant.citationPages", { pages: pages.join(", ") });
  }
  const page = pages[0] ?? String(citation.page);
  return t("assistant.citationPage", { page });
}

function responseState(message: Message, streaming: boolean) {
  if (message.error || ["failed", "interrupted"].includes(message.generation?.status ?? "")) {
    return "error" as const;
  }
  if (streaming) return "active" as const;
  if (message.generation?.status === "complete") return "complete" as const;
  return null;
}

export function AssistantMessage({
  message,
  isStreaming,
  isLatest,
  onRetry,
  onRegenerate,
}: {
  message: Message;
  isStreaming: boolean;
  isLatest: boolean;
  onRetry: () => void | Promise<void>;
  onRegenerate: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [selectedCitation, setSelectedCitation] =
    useState<CitationAnnotation | null>(null);
  const citations = message.annotations ?? [];
  const events = useMemo(() => message.events ?? [], [message.events]);
  const contentEvents = events.filter(
    (event): event is Extract<AssistantEvent, { type: "content" }> =>
      event.type === "content",
  );
  const content = contentEvents.length
    ? contentEvents.map((event) => event.text).join("")
    : message.content;
  const preEvents = useMemo(
    () =>
      events
        .map((event) => preEventLabel(event, t))
        .filter((item): item is NonNullable<typeof item> => !!item),
    [events, t],
  );
  const generation = message.generation;
  const canRetry =
    isLatest && generation?.terminal && generation.retryable && generation.status !== "complete";
  const canRegenerate = isLatest && generation?.terminal && generation.status === "complete";

  return (
    <div className="w-full" data-message-id={message.id}>
      <ResponseStatus state={responseState(message, isStreaming)} />

      {preEvents.length > 0 && (
        <div className="mb-4 overflow-hidden rounded-xl border border-white/70 bg-white/55 shadow-[0_3px_9px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-2xl">
          {preEvents.map((item, index) =>
            item.detail ? (
              <details
                key={`${item.title}-${index}`}
                className="group border-b border-gray-100 px-3 py-2 text-xs text-gray-600 last:border-b-0"
              >
                <summary className="flex cursor-pointer list-none items-center gap-2">
                  <span className={item.active ? "animate-spin" : undefined}>{item.icon}</span>
                  <span className="font-medium">{item.title}</span>
                </summary>
                <p className="mt-2 whitespace-pre-wrap border-l border-gray-200 pl-5 leading-5 text-gray-500">
                  {item.detail}
                </p>
              </details>
            ) : (
              <div
                key={`${item.title}-${index}`}
                className="flex items-center gap-2 border-b border-gray-100 px-3 py-2 text-xs text-gray-600 last:border-b-0"
              >
                <span className={item.active ? "animate-spin" : undefined}>{item.icon}</span>
                <span className="font-medium">{item.title}</span>
              </div>
            ),
          )}
        </div>
      )}

      {content && (
        <AssistantMarkdown
          text={content}
          citations={citations}
          onCitationClick={setSelectedCitation}
        />
      )}

      {selectedCitation && (
        <div className="mb-4 rounded-xl border border-blue-100 bg-blue-50/70 p-3 text-xs text-gray-700">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium text-gray-900">
                [{selectedCitation.ref}]{" "}
                {selectedCitation.kind === "case"
                  ? selectedCitation.case_name ?? selectedCitation.citation
                  : selectedCitation.filename}
              </p>
              <p className="mt-1 text-gray-500">
                {citationLocation(selectedCitation, t)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedCitation(null)}
              className="text-gray-400 hover:text-gray-700"
            >
              {t("common.actions.close")}
            </button>
          </div>
          <blockquote className="mt-2 border-l-2 border-blue-200 pl-3 font-serif leading-5">
            {displayCitationQuote(selectedCitation)}
          </blockquote>
        </div>
      )}

      {citations.length > 0 && !isStreaming && (
        <div className="mb-4 rounded-xl border border-white/70 bg-white/55 p-3 shadow-sm backdrop-blur-xl">
          <p className="mb-2 text-xs font-medium text-gray-500">
            {t("assistant.sources")}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {citations.map((citation) => (
              <button
                key={`${citation.ref}-${citation.kind === "case" ? citation.cluster_id : citation.document_id}`}
                type="button"
                onClick={() => setSelectedCitation(citation)}
                className="rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700 transition-colors hover:bg-gray-100"
              >
                [{citation.ref}]{" "}
                {citation.kind === "case"
                  ? citation.case_name ?? citation.citation
                  : citation.filename}
              </button>
            ))}
          </div>
        </div>
      )}

      {(message.error || generation?.status === "cancelled") && (
        <div
          role={message.error ? "alert" : undefined}
          className={`mb-3 rounded-lg px-3 py-2 text-sm ${
            message.error
              ? "border border-red-100 bg-red-50 text-red-700"
              : "border border-gray-200 bg-gray-50 text-gray-600"
          }`}
        >
          {message.error ?? t("assistant.cancelled")}
        </div>
      )}

      {!isStreaming && (content || canRetry || canRegenerate) && (
        <div className="flex items-center gap-1 text-gray-400">
          {content && (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(content).then(() => setCopied(true));
              }}
              className="rounded-md p-1.5 transition-colors hover:bg-gray-100 hover:text-gray-700"
              title={t("assistant.copyAnswer")}
              aria-label={t("assistant.copyAnswer")}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              onClick={() => void onRetry()}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors hover:bg-gray-100 hover:text-gray-700"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t("common.actions.retry")}
            </button>
          )}
          {canRegenerate && (
            <button
              type="button"
              onClick={() => void onRegenerate()}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors hover:bg-gray-100 hover:text-gray-700"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t("assistant.regenerate")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
