export type TabularChatStreamEvent = Record<string, unknown> & {
    type: string;
};

function parseEventLine(line: string): TabularChatStreamEvent | null {
    if (!line.startsWith("data:")) return null;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return null;
    try {
        const value: unknown = JSON.parse(payload);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return null;
        }
        const event = value as Record<string, unknown>;
        if (typeof event.type !== "string" || !event.type) return null;
        return event as TabularChatStreamEvent;
    } catch {
        return null;
    }
}

function drainCompleteLines(buffer: string): {
    events: TabularChatStreamEvent[];
    remainder: string;
} {
    const lines = buffer.split("\n");
    const remainder = lines.pop() ?? "";
    const events = lines.flatMap((line) => {
        const event = parseEventLine(line);
        return event ? [event] : [];
    });
    return { events, remainder };
}

export async function* iterateTabularChatEvents(
    response: Response,
): AsyncGenerator<TabularChatStreamEvent> {
    if (!response.body) throw new Error("No response body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const drained = drainCompleteLines(buffer);
            buffer = drained.remainder;
            for (const event of drained.events) yield event;
        }

        buffer += decoder.decode();
        const drained = drainCompleteLines(`${buffer}\n`);
        for (const event of drained.events) yield event;
    } finally {
        reader.releaseLock();
    }
}
