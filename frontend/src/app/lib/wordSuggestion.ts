import type { Citation } from "@/app/components/shared/types";

export type WordReviewMode = "review" | "rewrite";

export interface WordSuggestionStreamResult {
    text: string;
    chatId: string | null;
    citations: Citation[];
}

export function buildWordSuggestionPrompt(args: {
    mode: WordReviewMode;
    selection: string;
    instruction: string;
}): string {
    const task =
        args.mode === "review"
            ? "Review the selected clause and propose the smallest precise replacement that addresses the instruction."
            : "Rewrite the selected text according to the instruction while preserving its legal meaning unless the instruction requires a substantive change.";

    return `${task}

Instruction:
${args.instruction.trim()}

Selected Word text:
<selection>
${args.selection}
</selection>

Do not edit or create any project document. Return only the replacement text, with no heading, explanation, quotation marks, Markdown fence, or citation markers.`;
}

export function cleanSuggestionText(value: string): string {
    let text = value.trim();
    const fenced = text.match(/^```(?:text|markdown)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) text = fenced[1].trim();
    text = text.replace(
        /^(?:revised|replacement|suggested|rewritten)\s+text\s*:\s*/i,
        "",
    );
    return text.trim();
}

export async function readWordSuggestionStream(
    response: Response,
    onText?: (text: string) => void,
): Promise<WordSuggestionStreamResult> {
    if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `Suggestion request failed (${response.status}).`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Suggestion response did not include a stream.");

    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let chatId: string | null = null;
    let citations: Citation[] = [];

    const consumeLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") return;

        let data: Record<string, unknown>;
        try {
            data = JSON.parse(payload) as Record<string, unknown>;
        } catch {
            return;
        }

        if (data.type === "chat_id" && typeof data.chatId === "string") {
            chatId = data.chatId;
            return;
        }
        if (data.type === "content_delta" && typeof data.text === "string") {
            text += data.text;
            onText?.(text);
            return;
        }
        if (data.type === "citations" && Array.isArray(data.citations)) {
            citations = data.citations as Citation[];
            return;
        }
        if (data.type === "error") {
            throw new Error(
                typeof data.message === "string"
                    ? data.message
                    : "Vera could not generate a suggestion.",
            );
        }
    };

    while (true) {
        const { done, value } = await reader.read();
        buffer += done
            ? decoder.decode()
            : decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = done ? "" : (lines.pop() ?? "");
        for (const line of lines) consumeLine(line);
        if (done) {
            if (buffer.trim()) consumeLine(buffer);
            break;
        }
    }

    const cleaned = cleanSuggestionText(text);
    if (!cleaned) throw new Error("Vera returned an empty suggestion.");
    return { text: cleaned, chatId, citations };
}
