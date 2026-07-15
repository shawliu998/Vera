"use client";

// Durable Vera adaptation of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/hooks/useAssistantChat.ts
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import {
  cancelVeraAssistantJob,
  getVeraAssistantChat,
  getVeraAssistantJob,
  listVeraAssistantJobs,
  regenerateVeraAssistantJob,
  replayVeraAssistantJob,
  retryVeraAssistantJob,
  startVeraAssistantGeneration,
  streamVeraAssistantJob,
  type VeraAssistantChat,
  type VeraAssistantGenerationAccepted,
  type VeraAssistantGenerationStatus,
  type VeraAssistantMessage,
  type VeraAssistantStreamEvent,
} from "@/app/lib/veraAssistantApi";
import type {
  AssistantEvent,
  CitationAnnotation,
  DocumentCitationAnnotation,
  Message,
} from "@/app/components/shared/types";
import { useI18n } from "@/app/i18n";

interface UseAssistantChatOptions {
  chatId?: string;
  projectId?: string;
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function assistantText(message: VeraAssistantMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => block.text).join("");
}

function toUiMessage(message: VeraAssistantMessage): Message {
  const content = assistantText(message);
  const citations = (message.citations ?? []) as CitationAnnotation[];
  return {
    id: message.id,
    role: message.role,
    content,
    ...(message.files?.length
      ? {
          files: message.files.map((file) => ({
            filename: file.filename,
            document_id: file.document_id,
          })),
        }
      : {}),
    ...(message.role === "assistant"
      ? {
          events: content ? [{ type: "content" as const, text: content }] : [],
          annotations: citations,
          citationStatus: citations.length ? ("final" as const) : undefined,
        }
      : {}),
  };
}

function jobProjection(job: VeraAssistantGenerationStatus) {
  return {
    jobId: job.job_id,
    status: job.status,
    retryable: job.retryable,
    cancelRequested: job.cancel_requested,
    terminal: job.terminal,
  } as const;
}

function attachJobs(
  messages: Message[],
  jobs: VeraAssistantGenerationStatus[],
): Message[] {
  const byOutput = new Map(jobs.map((job) => [job.output_message_id, job]));
  return messages.map((message) => {
    const job = message.id ? byOutput.get(message.id) : undefined;
    return job ? { ...message, generation: jobProjection(job) } : message;
  });
}

function replaceOutputMessage(
  messages: Message[],
  outputMessageId: string,
  update: (message: Message) => Message,
): Message[] {
  const index = messages.findIndex((message) => message.id === outputMessageId);
  if (index < 0) {
    return [
      ...messages,
      update({
        id: outputMessageId,
        role: "assistant",
        content: "",
        events: [],
        annotations: [],
      }),
    ];
  }
  const next = [...messages];
  next[index] = update(next[index]);
  return next;
}

function finaliseStreamingEvents(events: AssistantEvent[]): AssistantEvent[] {
  return events.map((event) => {
    if (!("isStreaming" in event) || !event.isStreaming) return event;
    const next = { ...event };
    delete next.isStreaming;
    return next as AssistantEvent;
  });
}

function appendContentDelta(
  events: AssistantEvent[],
  text: string,
): AssistantEvent[] {
  const last = events.at(-1);
  if (last?.type === "content" && last.isStreaming) {
    return [
      ...events.slice(0, -1),
      { ...last, text: last.text + text },
    ];
  }
  return [
    ...finaliseStreamingEvents(events),
    { type: "content", text, isStreaming: true },
  ];
}

function appendReasoningDelta(
  events: AssistantEvent[],
  text: string,
): AssistantEvent[] {
  const last = events.at(-1);
  if (last?.type === "reasoning" && last.isStreaming) {
    return [
      ...events.slice(0, -1),
      { ...last, text: last.text + text },
    ];
  }
  return [
    ...finaliseStreamingEvents(events),
    { type: "reasoning", text, isStreaming: true },
  ];
}

function withoutPendingDocumentEvent(events: AssistantEvent[]) {
  const last = events.at(-1);
  return last?.type === "doc_read_start" || last?.type === "doc_find_start"
    ? events.slice(0, -1)
    : events;
}

function applyStreamEvent(
  message: Message,
  wire: VeraAssistantStreamEvent,
  localizeError: ReturnType<typeof useI18n>["errorMessage"],
): Message {
  const events = message.events ?? [];
  switch (wire.type) {
    case "chat_id":
    case "complete":
      return message;
    case "status":
      if (wire.status === "retrying") {
        return {
          ...message,
          content: "",
          events: [{ type: "status", status: "retrying", isStreaming: true }],
          annotations: [],
          citationStatus: undefined,
          error: undefined,
        };
      }
      return {
        ...message,
        events: [
          ...events.filter((event) => event.type !== "status"),
          { type: "status", status: wire.status, isStreaming: true },
        ],
      };
    case "content_delta": {
      const nextEvents = appendContentDelta(
        events.filter((event) => event.type !== "status"),
        wire.text,
      );
      return {
        ...message,
        content: nextEvents
          .filter(
            (event): event is Extract<AssistantEvent, { type: "content" }> =>
              event.type === "content",
          )
          .map((event) => event.text)
          .join(""),
        events: nextEvents,
      };
    }
    case "content_done":
    case "reasoning_block_end":
      return { ...message, events: finaliseStreamingEvents(events) };
    case "reasoning_delta":
      return { ...message, events: appendReasoningDelta(events, wire.text) };
    case "tool_call_start":
      return {
        ...message,
        events: [
          ...finaliseStreamingEvents(events),
          { type: "tool_call_start", name: wire.name, isStreaming: true },
        ],
      };
    case "doc_read_start":
      return {
        ...message,
        events: [
          ...finaliseStreamingEvents(events),
          { type: "doc_read_start", filename: wire.filename, isStreaming: true },
        ],
      };
    case "doc_read":
      return {
        ...message,
        events: [
          ...withoutPendingDocumentEvent(events),
          {
            type: "doc_read",
            filename: wire.filename,
            document_id: wire.document_id,
          },
        ],
      };
    case "doc_find_start":
      return {
        ...message,
        events: [
          ...finaliseStreamingEvents(events),
          {
            type: "doc_find_start",
            filename: wire.filename,
            query: wire.query,
            isStreaming: true,
          },
        ],
      };
    case "doc_find":
      return {
        ...message,
        events: [
          ...withoutPendingDocumentEvent(events),
          {
            type: "doc_find",
            filename: wire.filename,
            query: wire.query,
            total_matches: wire.total_matches,
          },
        ],
      };
    case "workflow_applied":
      return {
        ...message,
        events: [
          ...finaliseStreamingEvents(events),
          {
            type: "workflow_applied",
            workflow_id: wire.workflow_id,
            title: wire.title,
          },
        ],
      };
    case "citation_data": {
      const citation = wire as DocumentCitationAnnotation;
      const annotations = [
        ...(message.annotations ?? []).filter(
          (item) =>
            item.kind === "case" ||
            item.ref !== citation.ref ||
            item.document_id !== citation.document_id,
        ),
        citation,
      ].sort((left, right) => left.ref - right.ref);
      return {
        ...message,
        annotations,
        citationStatus: "partial",
      };
    }
    case "error": {
      const visibleError = localizeError({
        code: wire.code ?? "JOB_FAILED",
      });
      return {
        ...message,
        events: [
          ...finaliseStreamingEvents(events),
          { type: "error", message: visibleError },
        ],
        error: visibleError,
      };
    }
  }
}

function acceptedStatus(
  accepted: VeraAssistantGenerationAccepted,
): VeraAssistantGenerationStatus {
  return {
    job_id: accepted.job_id,
    chat_id: accepted.chat_id,
    prompt_message_id: accepted.prompt_message_id,
    output_message_id: accepted.output_message_id,
    status: "queued",
    attempt: 0,
    max_attempts: 1,
    retryable: false,
    cancel_requested: false,
    terminal: false,
    active_attempt: 1,
  };
}

export function useAssistantChat({
  chatId: initialChatId,
  projectId,
}: UseAssistantChatOptions = {}) {
  const { t, errorMessage } = useI18n();
  const {
    loadChats,
    setCurrentChatId,
  } = useChatHistoryContext();
  const [chat, setChat] = useState<VeraAssistantChat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatId, setChatId] = useState<string | undefined>(initialChatId);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    initialChatId ? "loading" : "ready",
  );
  const [loadError, setLoadError] = useState<unknown>(null);
  const [streamError, setStreamError] = useState<unknown>(null);
  const [latestJob, setLatestJob] =
    useState<VeraAssistantGenerationStatus | null>(null);
  const [streamRevision, setStreamRevision] = useState(0);
  const [loadRevision, setLoadRevision] = useState(0);
  const operationRef = useRef(false);
  const lastCursorRef = useRef(0);

  useEffect(() => {
    if (!initialChatId) {
      setChat(null);
      setChatId(undefined);
      setMessages([]);
      setLatestJob(null);
      setLoadError(null);
      setStreamError(null);
      setLoadState("ready");
      lastCursorRef.current = 0;
      setCurrentChatId(null);
      return;
    }
    const controller = new AbortController();
    setChat(null);
    setChatId(initialChatId);
    setMessages([]);
    setLatestJob(null);
    setStreamError(null);
    lastCursorRef.current = 0;
    setLoadState("loading");
    setLoadError(null);
    Promise.all([
      getVeraAssistantChat(initialChatId, controller.signal),
      listVeraAssistantJobs(initialChatId, 20, controller.signal),
    ])
      .then(([detail, jobs]) => {
        if (controller.signal.aborted) return;
        setChat(detail.chat);
        setChatId(detail.chat.id);
        setCurrentChatId(detail.chat.id);
        setMessages(attachJobs(detail.messages.map(toUiMessage), jobs));
        setLatestJob(jobs[0] ?? null);
        lastCursorRef.current = 0;
        setStreamError(null);
        setLoadState("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbort(error)) return;
        setLoadError(error);
        setLoadState("error");
      });
    return () => controller.abort();
  }, [initialChatId, loadRevision, setCurrentChatId]);

  const updateJobProjection = useCallback(
    (job: VeraAssistantGenerationStatus) => {
      setLatestJob(job);
      setMessages((current) =>
        replaceOutputMessage(current, job.output_message_id, (message) => ({
          ...message,
          generation: jobProjection(job),
          events: job.terminal
            ? finaliseStreamingEvents(message.events ?? [])
            : message.events,
          citationStatus:
            job.status === "complete" && (message.annotations?.length ?? 0) > 0
              ? "final"
              : message.citationStatus,
          error:
            message.error ??
            (job.status === "failed"
              ? t("assistant.errors.failed")
              : job.status === "interrupted"
                ? t("assistant.errors.interrupted")
                : undefined),
        })),
      );
    },
    [t],
  );

  const resumableJobId =
    latestJob && latestJob.status !== "complete" ? latestJob.job_id : null;
  const resumableOutputMessageId =
    latestJob && latestJob.status !== "complete"
      ? latestJob.output_message_id
      : null;

  useEffect(() => {
    if (!resumableJobId || !resumableOutputMessageId) return;
    const controller = new AbortController();
    const jobId = resumableJobId;
    const outputMessageId = resumableOutputMessageId;
    let closed = false;

    const consume = async () => {
      try {
        setStreamError(null);
        const replay = await replayVeraAssistantJob(jobId, 0, controller.signal);
        if (closed || controller.signal.aborted) return;
        lastCursorRef.current = 0;
        setMessages((current) =>
          replaceOutputMessage(current, outputMessageId, (message) => ({
            ...message,
            content: "",
            events: [],
            annotations: [],
            citationStatus: undefined,
            error: undefined,
          })),
        );
        for (const durable of replay.events) {
          if (durable.cursor <= lastCursorRef.current) continue;
          lastCursorRef.current = durable.cursor;
          setMessages((current) =>
            replaceOutputMessage(current, outputMessageId, (message) =>
              applyStreamEvent(message, durable.event, errorMessage),
            ),
          );
        }
        if (replay.terminal) {
          updateJobProjection(await getVeraAssistantJob(jobId, controller.signal));
          return;
        }
        for await (const durable of streamVeraAssistantJob(jobId, {
          cursor: replay.next_cursor,
          signal: controller.signal,
        })) {
          if (durable.cursor <= lastCursorRef.current) continue;
          lastCursorRef.current = durable.cursor;
          setMessages((current) =>
            replaceOutputMessage(current, outputMessageId, (message) =>
              applyStreamEvent(message, durable.event, errorMessage),
            ),
          );
        }
        if (closed || controller.signal.aborted) return;
        const status = await getVeraAssistantJob(jobId, controller.signal);
        updateJobProjection(status);
        if (status.status === "complete") {
          const detail = await getVeraAssistantChat(status.chat_id, controller.signal);
          const jobs = await listVeraAssistantJobs(status.chat_id, 20, controller.signal);
          if (closed || controller.signal.aborted) return;
          setChat(detail.chat);
          setMessages(attachJobs(detail.messages.map(toUiMessage), jobs));
          setLatestJob(jobs[0] ?? status);
          await loadChats();
        }
      } catch (error) {
        if (closed || controller.signal.aborted || isAbort(error)) return;
        setStreamError(error);
      }
    };

    void consume();
    return () => {
      closed = true;
      controller.abort();
    };
  }, [
    errorMessage,
    loadChats,
    resumableJobId,
    resumableOutputMessageId,
    streamRevision,
    updateJobProjection,
  ]);

  const handleChat = useCallback(
    async (message: Message): Promise<string | null> => {
      const prompt = message.content.trim();
      if (!prompt || operationRef.current) return null;
      operationRef.current = true;
      setStreamError(null);
      try {
        const accepted = await startVeraAssistantGeneration({
          messages: [
            {
              role: "user",
              content: prompt,
              ...(message.files?.length ? { files: message.files } : {}),
            },
          ],
          ...(chatId ? { chat_id: chatId } : {}),
          ...(projectId ? { project_id: projectId } : {}),
          ...(message.model ? { model_profile_id: message.model } : {}),
          ...(projectId && message.files?.length
            ? {
                attached_documents: message.files.flatMap((file) =>
                  file.document_id
                    ? [{ filename: file.filename, document_id: file.document_id }]
                    : [],
                ),
              }
            : {}),
        });
        const status = acceptedStatus(accepted);
        setChatId(accepted.chat_id);
        setCurrentChatId(accepted.chat_id);
        setMessages((current) => [
          ...current,
          {
            ...message,
            id: accepted.prompt_message_id,
            content: prompt,
          },
          {
            id: accepted.output_message_id,
            role: "assistant",
            content: "",
            events: [],
            annotations: [],
            generation: jobProjection(status),
          },
        ]);
        lastCursorRef.current = 0;
        setLatestJob(status);
        await loadChats();
        return accepted.chat_id;
      } catch (error) {
        setStreamError(error);
        return null;
      } finally {
        operationRef.current = false;
      }
    },
    [chatId, loadChats, projectId, setCurrentChatId],
  );

  const cancel = useCallback(async () => {
    if (!latestJob || latestJob.terminal || operationRef.current) return;
    operationRef.current = true;
    try {
      const result = await cancelVeraAssistantJob(latestJob.job_id);
      const next = {
        ...latestJob,
        status: result.status,
        cancel_requested: result.cancel_requested,
        terminal: result.terminal,
      };
      updateJobProjection(next);
    } catch (error) {
      setStreamError(error);
    } finally {
      operationRef.current = false;
    }
  }, [latestJob, updateJobProjection]);

  const retry = useCallback(async () => {
    if (!latestJob?.retryable || !latestJob.terminal || operationRef.current) {
      return;
    }
    operationRef.current = true;
    try {
      const accepted = await retryVeraAssistantJob(latestJob.job_id);
      const status = acceptedStatus(accepted);
      lastCursorRef.current = 0;
      setMessages((current) =>
        replaceOutputMessage(current, accepted.output_message_id, (message) => ({
          ...message,
          content: "",
          events: [],
          annotations: [],
          citationStatus: undefined,
          error: undefined,
          generation: jobProjection(status),
        })),
      );
      setLatestJob(status);
      setStreamRevision((current) => current + 1);
    } catch (error) {
      setStreamError(error);
    } finally {
      operationRef.current = false;
    }
  }, [latestJob]);

  const regenerate = useCallback(async () => {
    if (!latestJob?.terminal || operationRef.current) return;
    operationRef.current = true;
    try {
      const accepted = await regenerateVeraAssistantJob(latestJob.job_id);
      const status = acceptedStatus(accepted);
      lastCursorRef.current = 0;
      const [detail, jobs] = await Promise.all([
        getVeraAssistantChat(accepted.chat_id),
        listVeraAssistantJobs(accepted.chat_id, 20),
      ]);
      const acceptedJob =
        jobs.find((job) => job.job_id === accepted.job_id) ?? status;
      setChat(detail.chat);
      setMessages(attachJobs(detail.messages.map(toUiMessage), jobs));
      setLatestJob(acceptedJob);
      setStreamRevision((current) => current + 1);
    } catch (error) {
      setStreamError(error);
    } finally {
      operationRef.current = false;
    }
  }, [latestJob]);

  const resume = useCallback(() => {
    setStreamError(null);
    setStreamRevision((current) => current + 1);
  }, []);

  const reload = useCallback(() => {
    setLoadRevision((current) => current + 1);
  }, []);

  const isResponseLoading = Boolean(latestJob && !latestJob.terminal);

  return useMemo(
    () => ({
      chat,
      chatId,
      messages,
      setMessages,
      loadState,
      loadError,
      streamError,
      latestJob,
      isResponseLoading,
      handleChat,
      cancel,
      retry,
      regenerate,
      resume,
      reload,
    }),
    [
      cancel,
      chat,
      chatId,
      handleChat,
      isResponseLoading,
      latestJob,
      loadError,
      loadState,
      messages,
      regenerate,
      reload,
      resume,
      retry,
      streamError,
    ],
  );
}
