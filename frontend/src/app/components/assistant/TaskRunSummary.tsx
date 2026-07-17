"use client";

import { Check, FileText, Loader2, Wrench } from "lucide-react";
import type { AssistantEvent } from "@/app/components/shared/types";
import { useI18n, type MessageKey } from "@/app/i18n";

const MAX_TASK_PROGRESS_ITEMS = 6;

const TOOL_PROGRESS_KEYS: Readonly<Record<string, MessageKey>> = {
  run_contract_review: "assistant.events.runContractReview",
  get_contract_review: "assistant.events.getContractReview",
  run_workflow: "assistant.events.runWorkflow",
  get_workflow_run: "assistant.events.getWorkflowRun",
  list_documents: "assistant.events.listDocuments",
  read_document: "assistant.events.readDocument",
  fetch_documents: "assistant.events.fetchDocuments",
  find_in_document: "assistant.events.findInDocument",
};

export type TaskProgressItem = Readonly<{
  key: string;
  labelKey: MessageKey;
  values?: Record<string, string | number>;
  active?: boolean;
  kind: "tool" | "document" | "review" | "draft" | "status";
}>;

/** Convert durable runtime events into a small, truthful activity timeline. */
export function summarizeTaskRunEvents(
  events: readonly AssistantEvent[],
): TaskProgressItem[] {
  const entries = events.flatMap((event): TaskProgressItem[] => {
    switch (event.type) {
      case "status":
        return [{
          key: `status-${event.status}`,
          labelKey:
            event.status === "retrying"
              ? "assistant.events.retrying"
              : event.status === "queued"
                ? "assistant.events.queued"
                : "assistant.events.generating",
          active: event.isStreaming,
          kind: "status",
        }];
      case "tool_call_start":
        return [{
          key: `tool-${event.name}`,
          labelKey: TOOL_PROGRESS_KEYS[event.name] ?? "assistant.events.localTool",
          active: event.isStreaming,
          kind: "tool",
        }];
      case "doc_read":
        return [{
          key: `document-${event.document_id ?? event.filename}`,
          labelKey: "assistant.events.documentRead",
          values: { filename: event.filename },
          active: event.isStreaming,
          kind: "document",
        }];
      case "tabular_review_created":
        return [{
          key: `review-${event.review_id}`,
          labelKey: "assistant.events.reviewCreated",
          values: { title: event.title, count: event.document_count },
          kind: "review",
        }];
      case "draft_created":
        return [{
          key: `draft-${event.draft_id}`,
          labelKey: "assistant.events.draftCreated",
          values: { title: event.title },
          kind: "draft",
        }];
      default:
        return [];
    }
  });
  const unique = new Map<string, TaskProgressItem>();
  for (const entry of entries) unique.set(entry.key, entry);
  return [...unique.values()].slice(-MAX_TASK_PROGRESS_ITEMS);
}

export function TaskRunSummary({ events }: { events: readonly AssistantEvent[] }) {
  const { t } = useI18n();
  const progress = summarizeTaskRunEvents(events);
  if (progress.length === 0) return null;

  return (
    <div
      className="mb-4 overflow-hidden rounded-xl border border-white/70 bg-white/55 shadow-[0_3px_9px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-2xl"
      aria-label={t("assistant.events.taskProgress")}
    >
      {progress.map((item) => {
        const Icon =
          item.kind === "document"
            ? FileText
            : item.kind === "review" || item.kind === "draft"
              ? Check
              : item.kind === "status"
                ? Loader2
                : Wrench;
        return (
          <div
            key={item.key}
            className="flex items-center gap-2 border-b border-gray-100 px-3 py-2 text-xs text-gray-600 last:border-b-0"
          >
            <Icon className={`h-3.5 w-3.5 ${item.active ? "animate-spin" : ""}`} />
            <span className="font-medium">{t(item.labelKey, item.values)}</span>
          </div>
        );
      })}
    </div>
  );
}
