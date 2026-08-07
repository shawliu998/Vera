import {
    useEffect,
    useRef,
    useState,
    type SetStateAction,
} from "react";

import type { AssistantEvent } from "../shared/types";
import {
    replaceLastAssistantEvents,
    updateLastAssistantContent,
    updateLastContentEvent,
    type TRMessage,
} from "./tabularChatEvents";
import {
    finishTabularChatSession,
    startTabularChatSession,
    type TabularChatSessionOutcome,
} from "./tabularChatSession";

const DRIP_CHARS = 8;

export interface ActiveTabularChatSession {
    id: number;
    controller: AbortController;
    requestMessages: { role: "user" | "assistant"; content: string }[];
}

export function useTabularChatSession() {
    const [messages, setMessages] = useState<TRMessage[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const isLoadingRef = useRef(false);
    const activeIdRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);
    const dripIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const dripTargetRef = useRef("");
    const dripDisplayLenRef = useRef(0);
    const eventsRef = useRef<AssistantEvent[]>([]);

    function stopDrip() {
        if (dripIntervalRef.current !== null) {
            clearInterval(dripIntervalRef.current);
            dripIntervalRef.current = null;
        }
    }

    function isCurrent(sessionId: number): boolean {
        return activeIdRef.current === sessionId;
    }

    function resetRuntime() {
        stopDrip();
        dripTargetRef.current = "";
        dripDisplayLenRef.current = 0;
        eventsRef.current = [];
    }

    function replaceMessages(next: SetStateAction<TRMessage[]>) {
        abortRef.current?.abort();
        abortRef.current = null;
        activeIdRef.current += 1;
        resetRuntime();
        isLoadingRef.current = false;
        setIsLoading(false);
        setMessages(next);
    }

    function start(userText: string): ActiveTabularChatSession | null {
        if (!userText || isLoadingRef.current) return null;
        const session = startTabularChatSession(messages, userText);
        resetRuntime();
        const id = activeIdRef.current + 1;
        activeIdRef.current = id;
        const controller = new AbortController();
        abortRef.current = controller;
        setMessages(session.optimisticMessages);
        isLoadingRef.current = true;
        setIsLoading(true);
        return { id, controller, requestMessages: session.requestMessages };
    }

    function getEvents(sessionId: number): AssistantEvent[] | null {
        return isCurrent(sessionId) ? eventsRef.current : null;
    }

    function publishEvents(sessionId: number, events: AssistantEvent[]) {
        if (!isCurrent(sessionId)) return;
        eventsRef.current = events;
        setMessages((previous) =>
            replaceLastAssistantEvents(previous, events),
        );
    }

    function updateMessages(
        sessionId: number,
        updater: (previous: TRMessage[]) => TRMessage[],
    ) {
        if (!isCurrent(sessionId)) return;
        setMessages(updater);
    }

    function startDrip(sessionId: number) {
        if (dripIntervalRef.current !== null) return;
        dripIntervalRef.current = setInterval(() => {
            if (!isCurrent(sessionId)) {
                stopDrip();
                return;
            }
            const target = dripTargetRef.current;
            const displayLength = dripDisplayLenRef.current;
            if (displayLength >= target.length) return;
            const nextLength = Math.min(
                displayLength + DRIP_CHARS,
                target.length,
            );
            dripDisplayLenRef.current = nextLength;
            const visibleText = target.slice(0, nextLength);
            eventsRef.current = updateLastContentEvent(
                eventsRef.current,
                visibleText,
                true,
            );
            setMessages((previous) =>
                updateLastAssistantContent(previous, visibleText, true),
            );
        }, 16);
    }

    function appendContent(sessionId: number, text: string) {
        if (!isCurrent(sessionId) || !text) return;
        dripTargetRef.current += text;
        startDrip(sessionId);
    }

    function finish(
        sessionId: number,
        outcome: TabularChatSessionOutcome,
    ) {
        if (!isCurrent(sessionId)) return;
        stopDrip();
        const events = eventsRef.current;
        const receivedContent = dripTargetRef.current;
        setMessages((previous) =>
            finishTabularChatSession(
                previous,
                events,
                receivedContent,
                outcome,
            ),
        );
        abortRef.current = null;
        activeIdRef.current += 1;
        resetRuntime();
        isLoadingRef.current = false;
        setIsLoading(false);
    }

    function cancel() {
        const controller = abortRef.current;
        if (!controller) return;
        const sessionId = activeIdRef.current;
        controller.abort();
        finish(sessionId, "aborted");
    }

    useEffect(
        () => () => {
            abortRef.current?.abort();
            activeIdRef.current += 1;
            stopDrip();
            isLoadingRef.current = false;
        },
    );

    return {
        messages,
        isLoading,
        replaceMessages,
        start,
        cancel,
        getEvents,
        publishEvents,
        updateMessages,
        appendContent,
        finish,
    };
}
