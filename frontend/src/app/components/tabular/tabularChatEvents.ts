import type { TRCitationAnnotation } from "@/app/lib/mikeApi";
import type { AssistantEvent } from "../shared/types";

export interface TRMessage {
    role: "user" | "assistant";
    content: string;
    events?: AssistantEvent[];
    annotations?: TRCitationAnnotation[];
    isStreaming?: boolean;
}

export function parseCourtlistenerEventCases(value: unknown) {
    if (!Array.isArray(value)) return undefined;
    return value
        .map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                return null;
            }
            const row = item as Record<string, unknown>;
            return {
                cluster_id:
                    typeof row.cluster_id === "number" ? row.cluster_id : 0,
                case_name:
                    typeof row.case_name === "string" ? row.case_name : null,
                citation:
                    typeof row.citation === "string" ? row.citation : null,
                dateFiled:
                    typeof row.dateFiled === "string" ? row.dateFiled : null,
                url: typeof row.url === "string" ? row.url : null,
            };
        })
        .filter(
            (item): item is NonNullable<typeof item> =>
                !!item && item.cluster_id > 0,
        );
}

export function parseCourtlistenerCaseSearches(value: unknown) {
    if (!Array.isArray(value)) return undefined;
    return value
        .map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                return null;
            }
            const row = item as Record<string, unknown>;
            return {
                cluster_id:
                    typeof row.cluster_id === "number" ? row.cluster_id : null,
                query: typeof row.query === "string" ? row.query : "",
                total_matches:
                    typeof row.total_matches === "number"
                        ? row.total_matches
                        : 0,
                case_name:
                    typeof row.case_name === "string" ? row.case_name : null,
                citation:
                    typeof row.citation === "string" ? row.citation : null,
                error: typeof row.error === "string" ? row.error : undefined,
            };
        })
        .filter((item): item is NonNullable<typeof item> => !!item);
}

export function findLastContentIndex(events: AssistantEvent[]): number {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index].type === "content") return index;
    }
    return -1;
}

export function isStreamingPlaceholder(event: AssistantEvent): boolean {
    return event.type === "thinking" && !!event.isStreaming;
}

export function replaceLastAssistantEvents(
    messages: TRMessage[],
    events: AssistantEvent[],
): TRMessage[] {
    const last = messages[messages.length - 1];
    if (last?.role !== "assistant") return messages;
    return [
        ...messages.slice(0, -1),
        { ...last, events: [...events] },
    ];
}

export function updateLastAssistantContent(
    messages: TRMessage[],
    text: string,
    isStreaming = false,
): TRMessage[] {
    const last = messages[messages.length - 1];
    if (last?.role !== "assistant") return messages;
    const currentEvents = last.events ?? [];
    const events = updateLastContentEvent(currentEvents, text, isStreaming);
    if (events === currentEvents) return messages;
    return replaceLastAssistantEvents(messages, events);
}

export function updateLastContentEvent(
    events: AssistantEvent[],
    text: string,
    isStreaming = false,
): AssistantEvent[] {
    const index = findLastContentIndex(events);
    if (index < 0) return events;
    const next = [...events];
    next[index] = isStreaming
        ? { type: "content", text, isStreaming: true }
        : { type: "content", text };
    return next;
}

export function withoutStreamingPlaceholders(
    events: AssistantEvent[],
): AssistantEvent[] {
    const filtered = events.filter((event) => !isStreamingPlaceholder(event));
    return filtered.length === events.length ? events : filtered;
}

export function appendThinkingPlaceholder(
    events: AssistantEvent[],
): AssistantEvent[] {
    const last = events[events.length - 1];
    if (last && isStreamingPlaceholder(last)) return events;
    return [...events, { type: "thinking", isStreaming: true }];
}

export function appendAssistantEvent(
    events: AssistantEvent[],
    event: AssistantEvent,
): AssistantEvent[] {
    const base =
        event.type === "thinking"
            ? events
            : withoutStreamingPlaceholders(events);
    return [...base, event];
}

export function updateLastMatchingEvent(
    events: AssistantEvent[],
    predicate: (event: AssistantEvent) => boolean,
    updater: (event: AssistantEvent) => AssistantEvent,
): { events: AssistantEvent[]; matched: boolean } {
    let index = events.length - 1;
    while (index >= 0 && !predicate(events[index])) index -= 1;
    if (index < 0) return { events, matched: false };
    const next = [...events];
    next[index] = updater(events[index]);
    return { events: next, matched: true };
}

export function appendReasoningDelta(
    events: AssistantEvent[],
    text: string,
): AssistantEvent[] {
    const last = events[events.length - 1];
    if (last?.type === "reasoning" && last.isStreaming) {
        return [
            ...events.slice(0, -1),
            { type: "reasoning", text: last.text + text, isStreaming: true },
        ];
    }
    return [
        ...withoutStreamingPlaceholders(events),
        { type: "reasoning", text, isStreaming: true },
    ];
}

export function finishReasoningBlock(
    events: AssistantEvent[],
): AssistantEvent[] {
    const last = events[events.length - 1];
    if (last?.type !== "reasoning" || !last.isStreaming) return events;
    return [
        ...events.slice(0, -1),
        { type: "reasoning", text: last.text },
    ];
}

export function ensureStreamingContentEvent(
    events: AssistantEvent[],
): AssistantEvent[] {
    const last = events[events.length - 1];
    if (last?.type === "content" && last.isStreaming) return events;
    const finalized = withoutStreamingPlaceholders(events).map((event) =>
        event.type === "reasoning" && event.isStreaming
            ? { type: "reasoning" as const, text: event.text }
            : event,
    );
    return [
        ...finalized,
        { type: "content", text: "", isStreaming: true },
    ];
}
