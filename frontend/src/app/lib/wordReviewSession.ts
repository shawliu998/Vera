import type { ChatDetailOut, Citation } from "@/app/components/shared/types";
import {
    cleanSuggestionText,
    parseWordDocumentSuggestions,
    splitWordDocumentParagraphs,
    type WordReviewMode,
    type WordReviewScope,
    type WordSuggestionItem,
} from "@/app/lib/wordSuggestion";

export type WordSuggestionStatus =
    | "pending"
    | "applied"
    | "commented"
    | "skipped";

export type WordReviewSessionPointer = {
    version: 1;
    projectId: string;
    chatId: string;
    scope: WordReviewScope;
    mode: WordReviewMode;
    activeIndex: number;
    statuses: Record<string, WordSuggestionStatus>;
    documentId?: string;
    baseVersionId?: string;
    baseVersionNumber?: number | null;
    updatedAt: string;
};

export type RestoredWordReview = {
    items: Array<WordSuggestionItem & { status: WordSuggestionStatus }>;
    instruction: string;
    citations: Citation[];
    chatId: string;
    scope: WordReviewScope;
    mode: WordReviewMode;
    activeIndex: number;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const WORD_REVIEW_SESSION_KEY = "vera.word-review-session.v1";
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const VALID_STATUSES = new Set<WordSuggestionStatus>([
    "pending",
    "applied",
    "commented",
    "skipped",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPointer(value: unknown, now: number): value is WordReviewSessionPointer {
    if (!isRecord(value) || value.version !== 1) return false;
    if (
        typeof value.projectId !== "string" ||
        !value.projectId ||
        typeof value.chatId !== "string" ||
        !value.chatId ||
        !["selection", "document"].includes(String(value.scope)) ||
        !["review", "rewrite"].includes(String(value.mode)) ||
        !Number.isInteger(value.activeIndex) ||
        Number(value.activeIndex) < 0 ||
        !isRecord(value.statuses) ||
        typeof value.updatedAt !== "string"
    ) {
        return false;
    }

    const updatedAt = Date.parse(value.updatedAt);
    if (!Number.isFinite(updatedAt) || now - updatedAt > MAX_SESSION_AGE_MS) {
        return false;
    }

    const hasDocumentVersionBinding =
        value.documentId !== undefined ||
        value.baseVersionId !== undefined ||
        value.baseVersionNumber !== undefined;
    if (
        hasDocumentVersionBinding &&
        (typeof value.documentId !== "string" ||
            !value.documentId ||
            typeof value.baseVersionId !== "string" ||
            !value.baseVersionId ||
            !(
                value.baseVersionNumber === null ||
                (Number.isInteger(value.baseVersionNumber) &&
                    Number(value.baseVersionNumber) > 0)
            ))
    ) {
        return false;
    }

    return Object.values(value.statuses).every(
        (status) => typeof status === "string" && VALID_STATUSES.has(status as WordSuggestionStatus),
    );
}

export function loadWordReviewSessionPointer(
    storage: StorageLike,
    now = Date.now(),
): WordReviewSessionPointer | null {
    try {
        const raw = storage.getItem(WORD_REVIEW_SESSION_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        return isPointer(parsed, now) ? parsed : null;
    } catch {
        return null;
    }
}

export function persistWordReviewSessionPointer(
    storage: StorageLike,
    pointer: Omit<WordReviewSessionPointer, "version" | "updatedAt">,
    now = Date.now(),
): boolean {
    try {
        storage.setItem(
            WORD_REVIEW_SESSION_KEY,
            JSON.stringify({
                ...pointer,
                version: 1,
                updatedAt: new Date(now).toISOString(),
            } satisfies WordReviewSessionPointer),
        );
        return true;
    } catch {
        return false;
    }
}

export function clearWordReviewSessionPointer(storage: StorageLike): void {
    try {
        storage.removeItem(WORD_REVIEW_SESSION_KEY);
    } catch {
        // A blocked storage implementation should not break Word review.
    }
}

function extractTaggedText(content: string, tag: "selection" | "document"): string {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    const start = content.indexOf(open);
    const end = content.lastIndexOf(close);
    if (start === -1 || end < start + open.length) {
        throw new Error("The saved Word review does not contain its source text.");
    }
    const tail = content.slice(end + close.length);
    const sourceLengthMatch =
        tag === "document"
            ? tail.match(
                  /<vera_word_segment\b[^>]*\bsource_chars="(\d+)"[^>]*\/>/i,
              ) ??
              tail.match(
                  /<vera_word_source\s+tag="document"\s+chars="(\d+)"\s*\/>/i,
              )
            : tail.match(
                  /<vera_word_source\s+tag="selection"\s+chars="(\d+)"\s*\/>/i,
              );
    if (sourceLengthMatch) {
        const sourceLength = Number(sourceLengthMatch[1]);
        const sourceEnd = content[end - 1] === "\n" ? end - 1 : end;
        const sourceStart = sourceEnd - sourceLength;
        if (Number.isSafeInteger(sourceLength) && sourceStart >= 0) {
            return content.slice(sourceStart, sourceEnd);
        }
    }
    return content.slice(start + open.length, end).trim();
}

function extractInstruction(content: string): string {
    const startMarker = "Instruction:\n";
    const start = content.indexOf(startMarker);
    if (start === -1) {
        throw new Error("The saved Word review does not contain its instruction.");
    }
    const body = content.slice(start + startMarker.length);
    const endMarkers = ["\n\nSelected Word text:", "\n\nWord document text:"];
    const end = endMarkers
        .map((marker) => body.indexOf(marker))
        .filter((index) => index >= 0)
        .sort((left, right) => left - right)[0];
    const instruction = body.slice(0, end ?? body.length).trim();
    if (!instruction) {
        throw new Error("The saved Word review instruction is empty.");
    }
    return instruction;
}

function segmentMetadataTail(content: string): string {
    const documentEnd = content.lastIndexOf("</document>");
    return documentEnd >= 0
        ? content.slice(documentEnd + "</document>".length)
        : content;
}

function extractSegmentParagraphStart(content: string): number | null {
    const tail = segmentMetadataTail(content);
    const structured = tail.match(
        /<vera_word_segment\s+index="\d+"\s+count="\d+"\s+paragraph_start="(\d+)"(?:\s+source_chars="\d+")?\s*\/>/i,
    );
    if (structured) return Number(structured[1]);
    const legacy = tail.match(/beginning at document paragraph\s+(\d+)/i);
    return legacy ? Math.max(0, Number(legacy[1]) - 1) : null;
}

function extractSegmentIndex(content: string): number | null {
    const tail = segmentMetadataTail(content);
    const structured = tail.match(
        /<vera_word_segment\s+index="(\d+)"\s+count="\d+"\s+paragraph_start="\d+"(?:\s+source_chars="\d+")?\s*\/>/i,
    );
    if (structured) return Number(structured[1]);
    const legacy = tail.match(/This is segment\s+(\d+)\s+of\s+\d+/i);
    return legacy ? Math.max(0, Number(legacy[1]) - 1) : null;
}

function lastReviewTurn(detail: ChatDetailOut, scope: WordReviewScope) {
    for (let userIndex = detail.messages.length - 1; userIndex >= 0; userIndex -= 1) {
        const user = detail.messages[userIndex];
        if (user.role !== "user" || !user.content.trim()) continue;
        try {
            extractInstruction(user.content);
            extractTaggedText(user.content, scope);
        } catch {
            continue;
        }

        for (let index = userIndex + 1; index < detail.messages.length; index += 1) {
            const message = detail.messages[index];
            if (message.role === "user") break;
            if (
                message.role === "assistant" &&
                message.content.trim() &&
                !message.events?.some((event) => event.type === "error")
            ) {
                return { user, assistant: message };
            }
        }
    }
    throw new Error("The saved Word review is incomplete.");
}

function documentReviewTurns(detail: ChatDetailOut) {
    const turns: Array<{
        user: ChatDetailOut["messages"][number];
        assistant: ChatDetailOut["messages"][number];
    }> = [];
    for (let userIndex = 0; userIndex < detail.messages.length; userIndex += 1) {
        const user = detail.messages[userIndex];
        if (user.role !== "user" || !user.content.trim()) continue;
        try {
            extractInstruction(user.content);
            extractTaggedText(user.content, "document");
        } catch {
            continue;
        }
        for (let index = userIndex + 1; index < detail.messages.length; index += 1) {
            const message = detail.messages[index];
            if (message.role === "user") break;
            if (message.role === "assistant" && message.content.trim()) {
                turns.push({ user, assistant: message });
                break;
            }
        }
    }
    if (!turns.length) throw new Error("The saved Word review is incomplete.");
    return turns;
}

function finalAssistantContent(message: ChatDetailOut["messages"][number]): string {
    const contentEvents = message.events?.filter(
        (event): event is Extract<typeof event, { type: "content" }> =>
            event.type === "content",
    );
    return contentEvents?.at(-1)?.text ?? message.content;
}

export function restoreWordReviewFromChat(args: {
    pointer: WordReviewSessionPointer;
    detail: ChatDetailOut;
}): RestoredWordReview {
    if (
        args.detail.chat.id !== args.pointer.chatId ||
        args.detail.chat.project_id !== args.pointer.projectId
    ) {
        throw new Error("The saved Word review does not belong to this Matter.");
    }

    const turns =
        args.pointer.scope === "document"
            ? documentReviewTurns(args.detail)
            : [lastReviewTurn(args.detail, args.pointer.scope)];
    const validDocumentTurns:
        | Array<{
              turn: (typeof turns)[number];
              items: WordSuggestionItem[];
              segmentIndex: number | null;
          }>
        | null =
        args.pointer.scope === "document"
            ? turns.reduce<
                  Array<{
                      turn: (typeof turns)[number];
                      items: WordSuggestionItem[];
                      segmentIndex: number | null;
                  }>
              >((valid, turn) => {
                  if (
                      turn.assistant.events?.some(
                          (event) => event.type === "error",
                      )
                  ) {
                      return valid;
                  }
                  const paragraphStart = extractSegmentParagraphStart(
                      turn.user.content,
                  );
                  const segmentIndex = extractSegmentIndex(turn.user.content);
                  try {
                      const items = parseWordDocumentSuggestions(
                          finalAssistantContent(turn.assistant),
                          extractTaggedText(turn.user.content, "document"),
                          paragraphStart === null
                              ? { idOffset: 0 }
                              : { paragraphStart, idOffset: 0 },
                      );
                      const duplicateIndex =
                          segmentIndex === null
                              ? -1
                              : valid.findIndex(
                                    (previous) =>
                                        previous.segmentIndex === segmentIndex,
                                );
                      const completed = { turn, items, segmentIndex };
                      if (duplicateIndex >= 0) {
                          valid[duplicateIndex] = completed;
                      } else {
                          valid.push(completed);
                      }
                  } catch {
                      // A canceled stream or provider failure can leave a
                      // partial assistant message. Preserve earlier completed
                      // segments instead of invalidating the whole review.
                  }
                  return valid;
              }, [])
            : null;
    if (validDocumentTurns && validDocumentTurns.length === 0) {
        throw new Error("The saved Word review is incomplete.");
    }
    const effectiveTurns = validDocumentTurns
        ? validDocumentTurns.map(({ turn }) => turn)
        : turns;
    const instruction = extractInstruction(effectiveTurns[0].user.content);
    const baseItems =
        validDocumentTurns
            ? validDocumentTurns
                  .flatMap(({ items }) => items)
                  .map((item, index) => ({
                      ...item,
                      id: `word-suggestion-${index + 1}`,
                  }))
            : [
                  {
                      id: "word-suggestion-1",
                      original: extractTaggedText(turns[0].user.content, "selection"),
                      replacement: cleanSuggestionText(finalAssistantContent(turns[0].assistant)),
                      reason: "Addresses the saved instruction for the selected Word text.",
                  },
              ];

    if (baseItems.some((item) => !item.replacement.trim())) {
        throw new Error("The saved Word review does not contain a replacement.");
    }

    const items = baseItems.map((item) => ({
        ...item,
        status: args.pointer.statuses[item.id] ?? "pending",
    }));

    return {
        items,
        instruction,
        citations: effectiveTurns.flatMap(
            (turn) => turn.assistant.citations ?? [],
        ),
        chatId: args.pointer.chatId,
        scope: args.pointer.scope,
        mode: args.pointer.mode,
        activeIndex: items.length
            ? Math.min(args.pointer.activeIndex, items.length - 1)
            : 0,
    };
}

export function restoredWordReviewMatchesSource(
    review: Pick<RestoredWordReview, "items" | "scope">,
    currentSource: string,
): boolean {
    const source = currentSource.trim();
    if (!source) return false;
    const pendingItems = review.items.filter((item) => item.status === "pending");
    if (pendingItems.length === 0) return true;
    if (review.scope === "selection") {
        return pendingItems.length === 1 && pendingItems[0].original === source;
    }
    const paragraphs = splitWordDocumentParagraphs(source);
    return pendingItems.every((item) => {
        const paragraphIndex = item.locator?.paragraph_index;
        if (typeof paragraphIndex === "number" && Number.isInteger(paragraphIndex)) {
            const paragraph = paragraphs[paragraphIndex];
            const expectedParagraph = item.locator?.paragraph_text;
            return (
                !!paragraph &&
                (typeof expectedParagraph !== "string" ||
                    expectedParagraph.trim() === paragraph.trim()) &&
                paragraph.includes(item.original)
            );
        }
        const first = source.indexOf(item.original);
        return first >= 0 && first === source.lastIndexOf(item.original);
    });
}
