"use client";

// Local P0 rendering port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/assistant/AssistantMessage.tsx and its message/*
// children. Cloud connectors, case-law browsing, and document editing blocks
// are intentionally omitted; durable local reasoning, document reads/finds,
// citations, completion, retry, and regeneration remain real.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  Copy,
  FileSearch,
  FileText,
  FilePenLine,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Wrench,
} from "lucide-react";
import type {
  AssistantEvent,
  CitationAnnotation,
  DocumentCitationAnnotation,
  Message,
} from "@/app/components/shared/types";
import {
  displayCitationQuote,
  firstDocumentCitationViewerEntry,
  getDocumentCitationQuotes,
} from "@/app/components/shared/types";
import {
  ProjectCitationSourceViewer,
  type ProjectAssistantCitationSource,
} from "@/app/components/projects/ProjectCitationSourceViewer";
import { useI18n, type MessageKey, type Translate } from "@/app/i18n";
import { createVeraStudioDraftFromAssistant } from "@/app/lib/veraDocumentStudioApi";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { ResponseStatus } from "./ResponseStatus";

const TOOL_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  list_documents: "assistant.events.listDocuments",
  read_document: "assistant.events.readDocument",
  fetch_documents: "assistant.events.fetchDocuments",
  find_in_document: "assistant.events.findInDocument",
  read_studio_document: "assistant.events.readStudioDocument",
  suggest_studio_edit: "assistant.events.suggestStudioEdit",
  create_draft: "assistant.events.createDraft",
  read_draft: "assistant.events.readDraft",
  suggest_draft_edit: "assistant.events.suggestDraftEdit",
  list_workflows: "assistant.events.listWorkflows",
  read_workflow: "assistant.events.readWorkflow",
  run_workflow: "assistant.events.runWorkflow",
  get_workflow_run: "assistant.events.getWorkflowRun",
  search_legal_sources: "assistant.events.searchLegalSources",
  read_legal_source: "assistant.events.readLegalSource",
};

function preEventLabel(
  event: AssistantEvent,
  t: Translate,
): {
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
        title: t(TOOL_LABEL_KEYS[event.name] ?? "assistant.events.localTool"),
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
    case "draft_created":
      return {
        icon: <FilePenLine className="h-3.5 w-3.5" />,
        title: t("assistant.events.draftCreated", { title: event.title }),
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

function citationLocation(citation: CitationAnnotation, t: Translate): string {
  if (citation.kind === "case") {
    return (
      citation.citation ||
      citation.case_name ||
      t("assistant.caseFallback", {
        id: String(citation.cluster_id ?? "—"),
      })
    );
  }
  if (citation.kind === "legal_authority") {
    const location = [
      citation.locator.article,
      citation.locator.section,
      citation.locator.paragraph,
      citation.locator.page === undefined
        ? undefined
        : t("assistant.citationPage", { page: citation.locator.page }),
    ].filter((value): value is string => Boolean(value));
    return location.length
      ? location.join(" · ")
      : citation.source_type.replaceAll("_", " ");
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
  if (
    message.error ||
    ["failed", "interrupted"].includes(message.generation?.status ?? "")
  ) {
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
  studioHandoff,
  citationScope,
}: {
  message: Message;
  isStreaming: boolean;
  isLatest: boolean;
  onRetry: () => void | Promise<void>;
  onRegenerate: () => void | Promise<void>;
  studioHandoff?: Readonly<{ projectId: string; chatId: string }>;
  citationScope?: Readonly<{
    projectId: string;
    documentIds: readonly string[];
  }>;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [creatingDraft, setCreatingDraft] = useState(false);
  const [draftFailure, setDraftFailure] = useState(false);
  const [selectedCitation, setSelectedCitation] =
    useState<CitationAnnotation | null>(null);
  const [citationSource, setCitationSource] =
    useState<ProjectAssistantCitationSource | null>(null);
  const [citationSourceFailure, setCitationSourceFailure] = useState(false);
  const citations = message.annotations ?? [];
  const events = useMemo(() => message.events ?? [], [message.events]);
  const createdDrafts = useMemo(
    () =>
      events.filter(
        (event): event is Extract<AssistantEvent, { type: "draft_created" }> =>
          event.type === "draft_created",
      ),
    [events],
  );
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
    isLatest &&
    generation?.terminal &&
    generation.retryable &&
    generation.status !== "complete";
  const canRegenerate =
    isLatest && generation?.terminal && generation.status === "complete";
  const canCreateDraft =
    Boolean(studioHandoff) &&
    Boolean(message.id) &&
    Boolean(content.trim()) &&
    generation?.status === "complete";

  async function createStudioDraft() {
    if (!studioHandoff || !message.id || !canCreateDraft || creatingDraft)
      return;
    setCreatingDraft(true);
    setDraftFailure(false);
    try {
      const draft = await createVeraStudioDraftFromAssistant(
        studioHandoff.projectId,
        {
          chat_id: studioHandoff.chatId,
          assistant_message_id: message.id,
        },
      );
      router.push(
        `/projects/${draft.project_id}/documents/${draft.document_id}/studio`,
      );
    } catch {
      setDraftFailure(true);
    } finally {
      setCreatingDraft(false);
    }
  }

  function openCitation(citation: CitationAnnotation) {
    setCitationSourceFailure(false);
    if (
      citation.kind === "case" ||
      citation.kind === "legal_authority" ||
      !citationScope
    ) {
      setSelectedCitation(citation);
      return;
    }
    const documentCitation = citation as DocumentCitationAnnotation;
    // The source viewer highlights one exact page-bound excerpt. Never merge
    // later-page text into the first page and label that aggregate verified.
    const firstEntry = firstDocumentCitationViewerEntry(documentCitation);
    const quote = firstEntry?.quote.trim() ?? "";
    if (
      !documentCitation.version_id ||
      !citationScope.documentIds.includes(documentCitation.document_id) ||
      !quote
    ) {
      setSelectedCitation(null);
      setCitationSourceFailure(true);
      return;
    }
    setSelectedCitation(null);
    setCitationSource({
      kind: "assistant_document",
      documentId: documentCitation.document_id,
      versionId: documentCitation.version_id,
      filename: documentCitation.filename,
      quote,
      page: firstEntry?.page ?? null,
    });
  }

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
                  <span className={item.active ? "animate-spin" : undefined}>
                    {item.icon}
                  </span>
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
                <span className={item.active ? "animate-spin" : undefined}>
                  {item.icon}
                </span>
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
          onCitationClick={openCitation}
        />
      )}

      {createdDrafts.map((draft) => (
        <div
          key={`${draft.draft_id}-${draft.version_id}`}
          className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-blue-100 bg-blue-50/70 p-3"
          data-testid={`assistant-draft-result-${draft.draft_id}`}
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-gray-900">
              {draft.title}
            </p>
            <p className="mt-0.5 text-xs text-gray-500">
              {t("assistant.events.draftCreated", { title: draft.title })}
            </p>
          </div>
          <button
            type="button"
            onClick={() => router.push(draft.route)}
            className="flex shrink-0 items-center gap-1 rounded-md bg-white px-2.5 py-1.5 text-xs font-medium text-blue-700 shadow-sm ring-1 ring-blue-100 transition-colors hover:bg-blue-50"
          >
            <FilePenLine className="h-3.5 w-3.5" />
            {t("assistant.openDraft")}
          </button>
        </div>
      ))}

      {citationSourceFailure && (
        <p role="alert" className="mb-3 text-xs text-red-600">
          {t("assistant.errors.citationSource")}
        </p>
      )}

      {selectedCitation && (
        <div className="mb-4 rounded-xl border border-blue-100 bg-blue-50/70 p-3 text-xs text-gray-700">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium text-gray-900">
                [{selectedCitation.ref}]{" "}
                {selectedCitation.kind === "case"
                  ? (selectedCitation.case_name ?? selectedCitation.citation)
                  : selectedCitation.kind === "legal_authority"
                    ? selectedCitation.title
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
                key={`${citation.ref}-${
                  citation.kind === "case"
                    ? citation.cluster_id
                    : citation.kind === "legal_authority"
                      ? citation.title
                      : citation.document_id
                }`}
                type="button"
                onClick={() => openCitation(citation)}
                data-testid={`assistant-citation-open-${citation.ref}`}
                className="rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700 transition-colors hover:bg-gray-100"
              >
                [{citation.ref}]{" "}
                {citation.kind === "case"
                  ? (citation.case_name ?? citation.citation)
                  : citation.kind === "legal_authority"
                    ? citation.title
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

      {draftFailure && (
        <p role="alert" className="mb-3 text-xs text-red-600">
          {t("assistant.errors.studioDraft")}
        </p>
      )}

      {!isStreaming &&
        (content || canRetry || canRegenerate || canCreateDraft) && (
          <div className="flex items-center gap-1 text-gray-400">
            {content && (
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(content)
                    .then(() => setCopied(true));
                }}
                className="rounded-md p-1.5 transition-colors hover:bg-gray-100 hover:text-gray-700"
                title={t("assistant.copyAnswer")}
                aria-label={t("assistant.copyAnswer")}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            )}
            {canCreateDraft && (
              <button
                type="button"
                disabled={creatingDraft}
                onClick={() => void createStudioDraft()}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creatingDraft ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FilePenLine className="h-3.5 w-3.5" />
                )}
                {creatingDraft
                  ? t("assistant.creatingStudioDraft")
                  : t("assistant.createStudioDraft")}
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

      {citationSource && (
        <ProjectCitationSourceViewer
          source={citationSource}
          onClose={() => setCitationSource(null)}
        />
      )}
    </div>
  );
}
