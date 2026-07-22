import type { Citation } from "@/app/components/shared/types";

export type WordReviewMode = "review" | "rewrite";
export type WordReviewScope = "selection" | "document";

export interface WordSuggestionItem {
    id: string;
    original: string;
    replacement: string;
    reason: string;
    /**
     * Present only for a review against a Matter standard. The source itself
     * remains the existing Matter Chat citation payload.
     */
    standard?: string;
    deviation?: string;
    standardCitationRef?: number;
    /**
     * A compact position hint lets a document-wide Word search disambiguate a
     * repeated standard clause without exposing document internals in the UI.
     */
    locator?: Readonly<Record<string, unknown>>;
}

export const MAX_WORD_SUGGESTION_ANCHOR_CHARS = 255;
export const MIN_REVIEW_STANDARD_QUOTE_CHARS = 16;
export const TARGET_WORD_DOCUMENT_SEGMENT_CHARS = 14_000;
export const WORD_DOCUMENT_CHUNK_MIN_CHARS = 12_000;
export const WORD_DOCUMENT_CHUNK_MAX_CHARS = 16_000;

export type WordDocumentSegment = {
    index: number;
    paragraphStart: number;
    paragraphEnd: number;
    text: string;
};

/**
 * Split Word body text using the separator that the active surface actually
 * provides. Office.js uses carriage returns for paragraphs, while persisted
 * prompts use blank lines so paragraph boundaries remain legible to a model.
 */
export function splitWordDocumentParagraphs(documentText: string): string[] {
    if (/\r/.test(documentText)) {
        return documentText.replace(/\r\n/g, "\r").split("\r");
    }
    if (/\n\n/.test(documentText)) {
        return documentText.split("\n\n");
    }
    return documentText.split("\n");
}

export interface WordSuggestionStreamResult {
    text: string;
    chatId: string | null;
    citations: Citation[];
}

export class WordSuggestionStreamError extends Error {
    readonly chatId: string | null;
    readonly status: number | null;

    constructor(
        message: string,
        options?: { chatId?: string | null; status?: number | null },
    ) {
        super(message);
        this.name = "WordSuggestionStreamError";
        this.chatId = options?.chatId ?? null;
        this.status = options?.status ?? null;
    }
}

/**
 * A deterministic failure in the cited review-standard version or its
 * accepted document content. Transport and provider failures deliberately do
 * not use this class so a saved Word review can keep its pointer and retry.
 */
export class ReviewStandardSourceValidationError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "ReviewStandardSourceValidationError";
    }
}

/**
 * Only failures that prove the saved source/version cannot validate are
 * permanent. Unknown failures are retryable; this includes browser network
 * errors whose implementations do not expose an HTTP status.
 */
export function isDeterministicReviewStandardSourceError(
    error: unknown,
): boolean {
    if (error instanceof ReviewStandardSourceValidationError) return true;

    const explicitStatus =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof error.status === "number"
            ? error.status
            : null;
    const message = error instanceof Error ? error.message : String(error);
    const messageStatus = message.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
    const status = explicitStatus ?? (messageStatus ? Number(messageStatus) : null);

    return status === 400 || status === 404 || status === 410 || status === 422;
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
<vera_word_source tag="selection" chars="${args.selection.length}" />

Do not edit or create any project document. Return only the replacement text, with no heading, explanation, quotation marks, Markdown fence, or citation markers.`;
}

export function buildWordDocumentReviewPrompt(args: {
    mode: WordReviewMode;
    documentText: string;
    instruction: string;
    documentTextTruncated?: boolean;
    paragraphStart?: number;
    segmentIndex?: number;
    segmentCount?: number;
    reviewStandard?: { filename: string } | null;
}): string {
    const task =
        args.mode === "review"
            ? "Review the Word document and propose the smallest precise replacements that address the instruction."
            : "Identify the Word passages that should be rewritten to satisfy the instruction while preserving legal meaning unless a substantive change is required.";
    const truncationNote = args.documentTextTruncated
        ? "Only the first part of the document is available. Review only the supplied text and do not infer changes outside it."
        : "Review only the supplied document text.";
    const segmentNote =
        typeof args.paragraphStart === "number"
            ? `This is segment ${(args.segmentIndex ?? 0) + 1} of ${args.segmentCount ?? 1}, beginning at document paragraph ${args.paragraphStart + 1}. Only review this supplied segment.\n<vera_word_segment index="${args.segmentIndex ?? 0}" count="${args.segmentCount ?? 1}" paragraph_start="${args.paragraphStart}" source_chars="${args.documentText.length}" />`
            : `<vera_word_source tag="document" chars="${args.documentText.length}" />`;
    const standardInstructions = args.reviewStandard
        ? `\nReview standard:\nThe Matter document "${args.reviewStandard.filename}" is attached as the review standard. Read that document before suggesting a change. Only suggest a change where that standard supports a material drafting difference. For every suggestion, state the applicable standard, the difference in the Word document, and its matching citation reference. After the JSON object, append the normal hidden <CITATIONS> block. Every suggestion must cite one exact, uniquely occurring quotation from "${args.reviewStandard.filename}" that is at least ${MIN_REVIEW_STANDARD_QUOTE_CHARS} characters excluding whitespace. Do not put [N] citation markers inside the JSON object.\n`
        : "";
    const structuredFields = args.reviewStandard
        ? `\n- "standard": one concise statement of the applicable requirement from the attached Matter standard\n- "deviation": one concise statement of how the quoted Word passage differs from that requirement\n- "standard_citation_ref": the positive integer ref for that suggestion's exact quotation in the following hidden <CITATIONS> block`
        : "";

    return `${task}

Instruction:
${args.instruction.trim()}

Word document text:
<document>
${args.documentText}
</document>

${truncationNote}
${segmentNote}
${standardInstructions}

Return one JSON object with a \"suggestions\" array containing 0 to 5 items. Each item must contain these fields:
- \"original\": copy an exact, verbatim, uniquely occurring short passage from one paragraph of the supplied document text. It must be directly searchable in Word, contain no line break or tab, and be at most ${MAX_WORD_SUGGESTION_ANCHOR_CHARS} characters. Never shorten, paraphrase, or combine a passage to fit this limit; choose a different exact passage instead.
- \"replacement\": the complete text that should replace exactly the quoted \"original\" passage; preserve any context needed inside that passage, do not repeat text outside it, and include no line break
- \"reason\": one concise sentence explaining the legal or drafting issue${structuredFields}

Suggestions must not repeat or overlap the same document text. Return at most one suggestion for each paragraph; combine related changes within that paragraph into one exact replacement.

Do not edit or create any project document. Do not include Markdown, headings, or text outside the JSON object${args.reviewStandard ? " followed by the required hidden <CITATIONS> block" : ""}.`;
}

/**
 * Break a Word body into model-sized, paragraph-preserving slices. Paragraphs
 * are kept whole; chunks aim for 12k–16k characters. The text sent to the model
 * uses `\n\n` between paragraphs so the model can see paragraph boundaries
 * clearly while the stored paragraph index maps back to Word body text.
 */
export function segmentWordDocumentText(
    documentText: string,
    options?: {
        minChars?: number;
        targetChars?: number;
        maxChars?: number;
    },
): WordDocumentSegment[] {
    const target =
        options?.targetChars ?? TARGET_WORD_DOCUMENT_SEGMENT_CHARS;
    const min = options?.minChars ?? WORD_DOCUMENT_CHUNK_MIN_CHARS;
    const max = options?.maxChars ?? WORD_DOCUMENT_CHUNK_MAX_CHARS;

    if (!Number.isFinite(target) || target < 1) {
        throw new Error("Word document segment size must be positive.");
    }

    const paragraphs = splitWordDocumentParagraphs(documentText);
    const segments: WordDocumentSegment[] = [];
    let paragraphStart = 0;
    let current: string[] = [];
    let currentLength = 0;

    const flush = (paragraphEnd: number) => {
        if (!current.length) return;
        segments.push({
            index: segments.length,
            paragraphStart,
            paragraphEnd,
            text: current.join("\n\n"),
        });
        current = [];
        currentLength = 0;
    };

    for (const [index, paragraph] of paragraphs.entries()) {
        if (paragraph.length > max) {
            throw new Error(
                `One Word paragraph is longer than ${max.toLocaleString()} characters. Select the relevant text in Word and review it as Selected text.`,
            );
        }
        const separatorLength = current.length ? 2 : 0;
        const addedLength = paragraph.length + separatorLength;
        const nextLength = currentLength + addedLength;

        if (current.length === 0) {
            current.push(paragraph);
            currentLength = addedLength;
        } else if (nextLength <= target) {
            current.push(paragraph);
            currentLength = nextLength;
        } else if (currentLength < min && nextLength <= max) {
            current.push(paragraph);
            currentLength = nextLength;
        } else {
            flush(index - 1);
            paragraphStart = index;
            current.push(paragraph);
            currentLength = paragraph.length;
        }
    }
    flush(paragraphs.length - 1);
    return segments;
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

function exactOccurrenceCount(source: string, quote: string): number {
    let count = 0;
    let start = 0;
    while (start <= source.length - quote.length) {
        const index = source.indexOf(quote, start);
        if (index === -1) break;
        count += 1;
        start = index + Math.max(quote.length, 1);
    }
    return count;
}

function paragraphLocatorForExactQuote(
    source: string,
    quote: string,
): { index: number; text: string } | null {
    const paragraphs = splitWordDocumentParagraphs(source);
    const matches = paragraphs
        .map((paragraph, index) =>
            exactOccurrenceCount(paragraph, quote) === 1
                ? { index, text: paragraph }
                : null,
        )
        .filter(
            (match): match is { index: number; text: string } => match !== null,
        );
    return matches.length === 1 ? matches[0] : null;
}

function extractJsonObject(value: string): string {
    const cleaned = cleanSuggestionText(value);
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) {
        throw new Error(
            "Vera did not return a review list. Try generating the document review again.",
        );
    }
    return cleaned.slice(start, end + 1);
}

export function parseWordDocumentSuggestions(
    value: string,
    documentText: string,
    options?: {
        paragraphStart?: number;
        idOffset?: number;
        requiresReviewStandard?: boolean;
    },
): WordSuggestionItem[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(extractJsonObject(value));
    } catch (error) {
        if (error instanceof Error && /review list/i.test(error.message)) {
            throw error;
        }
        throw new Error(
            "Vera returned an incomplete review list. Try generating the document review again.",
        );
    }

    const suggestions =
        parsed && typeof parsed === "object" && "suggestions" in parsed
            ? (parsed as { suggestions?: unknown }).suggestions
            : null;
    if (!Array.isArray(suggestions) || suggestions.length > 5) {
        throw new Error("A document review must contain between 0 and 5 suggestions.");
    }

    const usedOriginals = new Set<string>();
    const usedParagraphIndexes = new Set<number>();
    const usedRanges: Array<{ start: number; end: number }> = [];
    const accepted: WordSuggestionItem[] = [];
    const overlongIndexes: number[] = [];

    for (const [index, candidate] of suggestions.entries()) {
        if (!candidate || typeof candidate !== "object") {
            throw new Error(`Suggestion ${index + 1} is incomplete. Generate the review again.`);
        }
        const item = candidate as Record<string, unknown>;
        const original = typeof item.original === "string" ? item.original.trim() : "";
        const replacement =
            typeof item.replacement === "string" ? item.replacement.trim() : "";
        const reason = typeof item.reason === "string" ? item.reason.trim() : "";
        const standard = typeof item.standard === "string" ? item.standard.trim() : "";
        const deviation = typeof item.deviation === "string" ? item.deviation.trim() : "";
        const standardCitationRef =
            typeof item.standard_citation_ref === "number" &&
            Number.isSafeInteger(item.standard_citation_ref) &&
            item.standard_citation_ref > 0
                ? item.standard_citation_ref
                : null;
        if (!original || !replacement || !reason) {
            throw new Error(`Suggestion ${index + 1} is incomplete. Generate the review again.`);
        }
        if (
            options?.requiresReviewStandard &&
            (!standard || !deviation || standardCitationRef === null)
        ) {
            throw new Error(
                `Suggestion ${index + 1} is missing its review-standard explanation or citation. Generate the review again.`,
            );
        }
        if (original === replacement) {
            throw new Error(`Suggestion ${index + 1} does not change the quoted text.`);
        }
        if (original.length > MAX_WORD_SUGGESTION_ANCHOR_CHARS) {
            // Word exact-search anchors cannot exceed this limit. Do not trim the
            // model's quote: that could create a different, unreviewed anchor.
            // Preserve other independently valid suggestions in the same result.
            overlongIndexes.push(index + 1);
            continue;
        }
        if (/[\r\n\t]/.test(original)) {
            throw new Error(
                `Suggestion ${index + 1} spans more than one paragraph. Generate the review again so Vera can locate one exact passage.`,
            );
        }
        if (
            typeof options?.paragraphStart === "number" &&
            /[\r\n]/.test(replacement)
        ) {
            throw new Error(
                `Suggestion ${index + 1} replaces more than one paragraph. Generate the document review again with a single-paragraph replacement, or review that text as a selection.`,
            );
        }
        if (usedOriginals.has(original)) {
            throw new Error(
                `Suggestion ${index + 1} repeats an earlier document passage. Generate the review again so each passage is reviewed once.`,
            );
        }
        usedOriginals.add(original);
        const occurrences = exactOccurrenceCount(documentText, original);
        if (occurrences === 0) {
            throw new Error(
                `Suggestion ${index + 1} no longer matches the loaded document. Refresh the document and generate the review again.`,
            );
        }
        if (occurrences > 1) {
            throw new Error(
                `Suggestion ${index + 1} matches more than one passage. Generate the review again so Vera can identify one exact location.`,
            );
        }
        const start = documentText.indexOf(original);
        const end = start + original.length;
        if (usedRanges.some((range) => start < range.end && end > range.start)) {
            throw new Error(
                `Suggestion ${index + 1} overlaps an earlier suggestion. Generate the review again so each change can be reviewed independently.`,
            );
        }
        usedRanges.push({ start, end });
        const paragraphLocator =
            typeof options?.paragraphStart === "number"
                ? paragraphLocatorForExactQuote(documentText, original)
                : null;
        if (typeof options?.paragraphStart === "number" && !paragraphLocator) {
            throw new Error(
                `Suggestion ${index + 1} could not be tied to one document paragraph. Generate the review again so Vera can verify the location before writing.`,
            );
        }
        if (
            paragraphLocator &&
            usedParagraphIndexes.has(paragraphLocator.index)
        ) {
            throw new Error(
                `Suggestion ${index + 1} adds a second change to the same paragraph. Generate the review again so changes in one paragraph are combined into one suggestion.`,
            );
        }
        if (paragraphLocator) usedParagraphIndexes.add(paragraphLocator.index);
        accepted.push({
            id: `word-suggestion-${(options?.idOffset ?? 0) + accepted.length + 1}`,
            original,
            replacement,
            reason,
            ...(standard ? { standard } : {}),
            ...(deviation ? { deviation } : {}),
            ...(standardCitationRef !== null ? { standardCitationRef } : {}),
            ...(typeof options?.paragraphStart === "number"
                ? {
                      locator: {
                          paragraph_index:
                              options.paragraphStart +
                              (paragraphLocator?.index ?? 0),
                          paragraph_text: paragraphLocator?.text ?? "",
                      },
                  }
                : {}),
        });
    }

    if (accepted.length === 0 && overlongIndexes.length > 0) {
        throw new Error(
            `No suggestion could be located because ${overlongIndexes.length === 1 ? "its quote is" : "their quotes are"} more than ${MAX_WORD_SUGGESTION_ANCHOR_CHARS} characters. Generate the review again using shorter exact document passages.`,
        );
    }

    return accepted;
}

function normalizeReviewStandardQuote(value: string): string {
    return value
        .normalize("NFKC")
        .trim()
        .replace(/\s+/gu, " ")
        .toLocaleLowerCase();
}

function hasUniqueReviewStandardQuote(
    sourceText: string,
    quote: string,
): boolean {
    const normalizedQuote = normalizeReviewStandardQuote(quote);
    if (
        normalizedQuote.replace(/\s/gu, "").length <
        MIN_REVIEW_STANDARD_QUOTE_CHARS
    ) {
        return false;
    }
    const normalizedSource = normalizeReviewStandardQuote(sourceText);
    const firstMatch = normalizedSource.indexOf(normalizedQuote);
    return (
        firstMatch >= 0 &&
        normalizedSource.indexOf(normalizedQuote, firstMatch + 1) === -1
    );
}

export function findReviewStandardCitation(
    citations: Citation[],
    documentId: string,
    citationRef: number | undefined,
): Citation | null {
    const ref = citationRef;
    if (typeof ref !== "number" || !Number.isSafeInteger(ref) || ref < 1) {
        return null;
    }
    const matches = citations.filter((citation) => citation.ref === ref);
    if (matches.length !== 1) return null;
    const [citation] = matches;
    return citation.kind !== "case" &&
        citation.document_id === documentId &&
        typeof citation.version_id === "string" &&
        citation.version_id.length > 0 &&
        citation.quote.trim().length > 0
        ? citation
        : null;
}

/**
 * Return a review-standard citation only when its canonical quote can be
 * uniquely re-located in the exact cited document-version text. This is the
 * source gate used before Word writes; presentation-only quote highlighting
 * remains intentionally more permissive elsewhere in the product.
 */
export function findLocatedReviewStandardCitation(
    citations: Citation[],
    documentId: string,
    citationRef: number | undefined,
    sourceText: string,
): Citation | null {
    const citation = findReviewStandardCitation(
        citations,
        documentId,
        citationRef,
    );
    if (!citation || citation.kind === "case") return null;
    return hasUniqueReviewStandardQuote(sourceText, citation.quote)
        ? citation
        : null;
}

export function highestCitationRef(citations: Citation[]): number {
    return citations.reduce(
        (highest, citation) =>
            Number.isSafeInteger(citation.ref) && citation.ref > highest
                ? citation.ref
                : highest,
        0,
    );
}

export function offsetCitationRefs(
    citations: Citation[],
    offset: number,
): Citation[] {
    if (!offset) return citations;
    return citations.map((citation) => ({
        ...citation,
        ref: citation.ref + offset,
    })) as Citation[];
}

export function offsetReviewStandardCitationRefs(
    items: WordSuggestionItem[],
    offset: number,
): WordSuggestionItem[] {
    if (!offset) return items;
    return items.map((item) =>
        item.standardCitationRef === undefined
            ? item
            : {
                  ...item,
                  standardCitationRef: item.standardCitationRef + offset,
            },
    );
}

export async function readWordSuggestionStream(
    response: Response,
    onText?: (text: string) => void,
): Promise<WordSuggestionStreamResult> {
    if (!response.ok) {
        const detail = await response.text();
        throw new WordSuggestionStreamError(
            detail
                ? `Suggestion request failed (${response.status}): ${detail}`
                : `Suggestion request failed (${response.status}).`,
            { status: response.status },
        );
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
        if (data.type === "tool_call_start") {
            // Text emitted before a tool call is a progress preface, not the
            // replacement Word should insert. The next content block is the
            // model's answer after the tool result.
            text = "";
            citations = [];
            onText?.(text);
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
            throw new WordSuggestionStreamError(
                typeof data.message === "string"
                    ? data.message
                    : "Vera could not generate a suggestion.",
                { chatId },
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
