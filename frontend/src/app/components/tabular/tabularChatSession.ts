import type { AssistantEvent } from "../shared/types";
import {
    replaceLastAssistantEvents,
    updateLastAssistantContent,
    withoutStreamingPlaceholders,
    type TRMessage,
} from "./tabularChatEvents";

export interface TabularChatSessionStart {
    requestMessages: { role: "user" | "assistant"; content: string }[];
    optimisticMessages: TRMessage[];
}

export type TabularChatSessionOutcome = "complete" | "aborted" | "failed";

export function startTabularChatSession(
    messages: TRMessage[],
    userText: string,
): TabularChatSessionStart {
    const requestMessages = [
        ...messages.map((message) => ({
            role: message.role,
            content: message.content,
        })),
        { role: "user" as const, content: userText },
    ];
    return {
        requestMessages,
        optimisticMessages: [
            ...messages,
            { role: "user", content: userText },
            {
                role: "assistant",
                content: "",
                events: [],
                isStreaming: true,
            },
        ],
    };
}

export function finishTabularChatSession(
    messages: TRMessage[],
    events: AssistantEvent[],
    receivedContent: string,
    outcome: TabularChatSessionOutcome,
): TRMessage[] {
    const cleanEvents = withoutStreamingPlaceholders(events);
    let next = replaceLastAssistantEvents(messages, cleanEvents);
    if (receivedContent) {
        next = updateLastAssistantContent(next, receivedContent);
    }

    const last = next[next.length - 1];
    if (last?.role !== "assistant") return messages;
    const finalEvents = [...(last.events ?? [])];
    const hasContent = finalEvents.some(
        (event) => event.type === "content" && !!event.text,
    );
    if (!hasContent && outcome !== "complete") {
        finalEvents.push({
            type: "content",
            text:
                outcome === "aborted"
                    ? ""
                    : "An error occurred. Please try again.",
        });
    }
    return [
        ...next.slice(0, -1),
        { ...last, events: finalEvents, isStreaming: false },
    ];
}
