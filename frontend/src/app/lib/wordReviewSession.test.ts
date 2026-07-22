import assert from "node:assert/strict";
import test from "node:test";
import type { ChatDetailOut } from "@/app/components/shared/types";
import {
    buildWordDocumentReviewPrompt,
    buildWordSuggestionPrompt,
} from "./wordSuggestion";
import {
    WORD_REVIEW_SESSION_KEY,
    loadWordReviewSessionPointer,
    persistWordReviewSessionPointer,
    restoredWordReviewMatchesSource,
    restoreWordReviewFromChat,
    type WordReviewSessionPointer,
} from "./wordReviewSession";

class MemoryStorage {
    private readonly values = new Map<string, string>();

    getItem(key: string) {
        return this.values.get(key) ?? null;
    }

    setItem(key: string, value: string) {
        this.values.set(key, value);
    }

    removeItem(key: string) {
        this.values.delete(key);
    }
}

const NOW = Date.parse("2026-07-22T12:00:00.000Z");

function pointer(
    overrides: Partial<WordReviewSessionPointer> = {},
): WordReviewSessionPointer {
    return {
        version: 1,
        projectId: "matter-1",
        chatId: "chat-1",
        scope: "selection",
        mode: "review",
        activeIndex: 0,
        statuses: { "word-suggestion-1": "pending" },
        updatedAt: new Date(NOW).toISOString(),
        ...overrides,
    };
}

function detail(args: {
    user: string;
    assistant: string;
    assistantEvents?: ChatDetailOut["messages"][number]["events"];
    trailingMessages?: ChatDetailOut["messages"];
}): ChatDetailOut {
    return {
        chat: {
            id: "chat-1",
            project_id: "matter-1",
            user_id: "user-1",
            title: "Word review",
            created_at: new Date(NOW).toISOString(),
        },
        messages: [
            { id: "message-1", role: "user", content: args.user },
            {
                id: "message-2",
                role: "assistant",
                content: args.assistant,
                citations: [],
                events: args.assistantEvents,
            },
            ...(args.trailingMessages ?? []),
        ],
    };
}

test("persists only the review pointer and restores valid progress", () => {
    const storage = new MemoryStorage();
    assert.equal(
        persistWordReviewSessionPointer(
            storage,
            {
                projectId: "matter-1",
                chatId: "chat-1",
                scope: "document",
                mode: "review",
                activeIndex: 1,
                statuses: {
                    "word-suggestion-1": "commented",
                    "word-suggestion-2": "pending",
                },
            },
            NOW,
        ),
        true,
    );
    const raw = storage.getItem(WORD_REVIEW_SESSION_KEY) ?? "";
    assert.doesNotMatch(raw, /Supplier|replacement|instruction/i);
    assert.deepEqual(loadWordReviewSessionPointer(storage, NOW), {
        version: 1,
        projectId: "matter-1",
        chatId: "chat-1",
        scope: "document",
        mode: "review",
        activeIndex: 1,
        statuses: {
            "word-suggestion-1": "commented",
            "word-suggestion-2": "pending",
        },
        updatedAt: new Date(NOW).toISOString(),
    });
});

test("persists an optional Matter document version binding without invalidating legacy pointers", () => {
    const storage = new MemoryStorage();
    persistWordReviewSessionPointer(
        storage,
        {
            projectId: "matter-1",
            chatId: "chat-1",
            scope: "document",
            mode: "review",
            activeIndex: 0,
            statuses: { "word-suggestion-1": "pending" },
            documentId: "document-1",
            baseVersionId: "version-2",
            baseVersionNumber: 2,
        },
        NOW,
    );
    assert.deepEqual(loadWordReviewSessionPointer(storage, NOW), {
        version: 1,
        projectId: "matter-1",
        chatId: "chat-1",
        scope: "document",
        mode: "review",
        activeIndex: 0,
        statuses: { "word-suggestion-1": "pending" },
        documentId: "document-1",
        baseVersionId: "version-2",
        baseVersionNumber: 2,
        updatedAt: new Date(NOW).toISOString(),
    });

    storage.setItem(
        WORD_REVIEW_SESSION_KEY,
        JSON.stringify(pointer({ documentId: "document-1" })),
    );
    assert.equal(
        loadWordReviewSessionPointer(storage, NOW),
        null,
        "partial bindings must fail closed",
    );
    storage.setItem(WORD_REVIEW_SESSION_KEY, JSON.stringify(pointer()));
    assert.deepEqual(loadWordReviewSessionPointer(storage, NOW), pointer());
});

test("ignores expired or malformed review pointers", () => {
    const storage = new MemoryStorage();
    storage.setItem(WORD_REVIEW_SESSION_KEY, "not-json");
    assert.equal(loadWordReviewSessionPointer(storage, NOW), null);
    storage.setItem(
        WORD_REVIEW_SESSION_KEY,
        JSON.stringify(pointer({ updatedAt: "2026-06-01T00:00:00.000Z" })),
    );
    assert.equal(loadWordReviewSessionPointer(storage, NOW), null);
});

test("restores a selected-text suggestion from the existing Matter chat", () => {
    const user = buildWordSuggestionPrompt({
        mode: "review",
        instruction: "Use a defined notice period.",
        selection: "The Supplier may change the Fees at any time.",
    });
    const restored = restoreWordReviewFromChat({
        pointer: pointer({ statuses: { "word-suggestion-1": "commented" } }),
        detail: detail({
            user,
            assistant: "The Supplier may change the Fees on 30 days' written notice.",
        }),
    });
    assert.equal(restored.instruction, "Use a defined notice period.");
    assert.equal(restored.items[0].status, "commented");
    assert.equal(restored.items[0].original, "The Supplier may change the Fees at any time.");
    assert.equal(
        restoredWordReviewMatchesSource(
            restored,
            "The Supplier may change the Fees at any time.",
        ),
        true,
    );
    assert.equal(
        restoredWordReviewMatchesSource(restored, "The text changed."),
        true,
        "a completed comment decision remains restorable after the selection moves",
    );
});

test("keeps a pending selected-text review locked to its original selection", () => {
    const user = buildWordSuggestionPrompt({
        mode: "review",
        instruction: "Use a defined notice period.",
        selection: "The Supplier may change the Fees at any time.",
    });
    const restored = restoreWordReviewFromChat({
        pointer: pointer(),
        detail: detail({
            user,
            assistant: "The Supplier may change the Fees on 30 days' written notice.",
        }),
    });

    assert.equal(restoredWordReviewMatchesSource(restored, "The text changed."), false);
});

test("restores the last successful selected-text review when a later retry failed", () => {
    const selection = "The Supplier may change the Fees at any time.";
    const prompt = buildWordSuggestionPrompt({
        mode: "review",
        instruction: "Use a defined notice period.",
        selection,
    });
    const restored = restoreWordReviewFromChat({
        pointer: pointer(),
        detail: detail({
            user: prompt,
            assistant:
                "The Supplier may change the Fees on 30 days' written notice.",
            trailingMessages: [
                { id: "retry-user", role: "user", content: prompt },
                {
                    id: "retry-assistant",
                    role: "assistant",
                    content:
                        "The Supplier may change the Fees immediately without notice.",
                    citations: [],
                    events: [
                        {
                            type: "content",
                            text: "The Supplier may change the Fees immediately without notice.",
                        },
                        { type: "error", message: "503 provider queued" },
                    ],
                },
            ],
        }),
    });

    assert.equal(restored.items[0].original, selection);
    assert.equal(
        restored.items[0].replacement,
        "The Supplier may change the Fees on 30 days' written notice.",
    );
});

test("restores a document suggestion queue and validates the current document", () => {
    const documentText = [
        "The Supplier may change the Fees at any time.",
        "The Customer must pay every invoice within 10 days.",
    ].join("\n");
    const user = buildWordDocumentReviewPrompt({
        mode: "review",
        instruction: "Balance the commercial terms.",
        documentText,
    });
    const assistant = JSON.stringify({
        suggestions: [
            {
                original: "The Supplier may change the Fees at any time.",
                replacement: "The Supplier may change the Fees on 30 days' written notice.",
                reason: "Adds a defined notice period.",
            },
            {
                original: "The Customer must pay every invoice within 10 days.",
                replacement: "The Customer must pay each undisputed invoice within 30 days.",
                reason: "Adds a dispute carve-out.",
            },
        ],
    });
    const restored = restoreWordReviewFromChat({
        pointer: pointer({
            scope: "document",
            activeIndex: 1,
            statuses: {
                "word-suggestion-1": "applied",
                "word-suggestion-2": "pending",
            },
        }),
        detail: detail({ user, assistant }),
    });
    assert.equal(restored.items.length, 2);
    assert.equal(restored.activeIndex, 1);
    assert.equal(restored.items[0].status, "applied");
    assert.equal(restoredWordReviewMatchesSource(restored, documentText), true);
    const afterFirstApplied = documentText.replace(
        "The Supplier may change the Fees at any time.",
        "The Supplier may change the Fees on 30 days' written notice.",
    );
    assert.equal(
        restoredWordReviewMatchesSource(restored, afterFirstApplied),
        true,
        "an applied item's former text must not invalidate a remaining pending item",
    );
    assert.equal(
        restoredWordReviewMatchesSource(
            restored,
            documentText.replace("within 10 days", "within 20 days"),
        ),
        false,
    );
});

test("restores the latest Word review turn after ordinary Matter chat messages", () => {
    const user = buildWordSuggestionPrompt({
        mode: "review",
        instruction: "Use a defined notice period.",
        selection: "The Supplier may change the Fees at any time.",
    });
    const restored = restoreWordReviewFromChat({
        pointer: pointer(),
        detail: detail({
            user,
            assistant: "The Supplier may change the Fees on 30 days' written notice.",
            trailingMessages: [
                {
                    id: "message-3",
                    role: "user",
                    content: "Summarize the commercial context for the partner.",
                },
                {
                    id: "message-4",
                    role: "assistant",
                    content: "This is a later ordinary Matter-chat response.",
                    citations: [],
                },
            ],
        }),
    });

    assert.equal(restored.instruction, "Use a defined notice period.");
    assert.equal(
        restored.items[0].replacement,
        "The Supplier may change the Fees on 30 days' written notice.",
    );
});

test("restores a completed selected-text decision after Word text changes", () => {
    const user = buildWordSuggestionPrompt({
        mode: "review",
        instruction: "Use a defined notice period.",
        selection: "The Supplier may change the Fees at any time.",
    });
    const restored = restoreWordReviewFromChat({
        pointer: pointer({ statuses: { "word-suggestion-1": "applied" } }),
        detail: detail({
            user,
            assistant: "The Supplier may change the Fees on 30 days' written notice.",
        }),
    });

    assert.equal(
        restoredWordReviewMatchesSource(
            restored,
            "The Supplier may change the Fees on 30 days' written notice.",
        ),
        true,
    );
});

test("restores only the final assistant content block after a tool preface", () => {
    const user = buildWordSuggestionPrompt({
        mode: "review",
        instruction: "Use a defined notice period.",
        selection: "The Supplier may change the Fees at any time.",
    });
    const restored = restoreWordReviewFromChat({
        pointer: pointer(),
        detail: detail({
            user,
            assistant:
                "Let me check the project documents.The Supplier may change the Fees on 30 days' written notice.",
            assistantEvents: [
                { type: "content", text: "Let me check the project documents." },
                { type: "doc_find", filename: "Agreement.docx", query: "Fees", total_matches: 1 },
                {
                    type: "content",
                    text: "The Supplier may change the Fees on 30 days' written notice.",
                },
            ],
        }),
    });

    assert.equal(
        restored.items[0].replacement,
        "The Supplier may change the Fees on 30 days' written notice.",
    );
});

test("restores queued suggestions from multiple document segments in one Matter chat", () => {
    const repeated = "This Agreement is governed by the laws of England.";
    const firstSegment = `Opening.\n\n${repeated}`;
    const secondSegment = `Middle.\n\n${repeated}`;
    const firstUser = buildWordDocumentReviewPrompt({
        mode: "review",
        instruction: "Add an exclusive forum.",
        documentText: firstSegment,
        paragraphStart: 0,
        segmentIndex: 0,
        segmentCount: 2,
    });
    const secondUser = buildWordDocumentReviewPrompt({
        mode: "review",
        instruction: "Add an exclusive forum.",
        documentText: secondSegment,
        paragraphStart: 2,
        segmentIndex: 1,
        segmentCount: 2,
    });
    const replacement = "This Agreement is governed by the laws of England and Wales, with exclusive jurisdiction in London.";
    const restored = restoreWordReviewFromChat({
        pointer: pointer({
            scope: "document",
            activeIndex: 1,
            statuses: {
                "word-suggestion-1": "commented",
                "word-suggestion-2": "pending",
            },
        }),
        detail: {
            chat: {
                id: "chat-1",
                project_id: "matter-1",
                user_id: "user-1",
                title: "Word review",
                created_at: new Date(NOW).toISOString(),
            },
            messages: [
                { id: "message-1", role: "user", content: firstUser },
                {
                    id: "message-2",
                    role: "assistant",
                    content: JSON.stringify({ suggestions: [{ original: repeated, replacement, reason: "Adds a forum." }] }),
                    citations: [],
                },
                { id: "message-3", role: "user", content: secondUser },
                {
                    id: "message-4",
                    role: "assistant",
                    content: JSON.stringify({ suggestions: [{ original: repeated, replacement, reason: "Adds a forum." }] }),
                    citations: [],
                },
                { id: "message-5", role: "user", content: "Summarize the issue." },
                { id: "message-6", role: "assistant", content: "Ordinary Matter chat.", citations: [] },
            ],
        },
    });

    assert.deepEqual(restored.items.map((item) => item.id), [
        "word-suggestion-1",
        "word-suggestion-2",
    ]);
    assert.deepEqual(restored.items.map((item) => item.status), ["commented", "pending"]);
    assert.deepEqual(restored.items.map((item) => item.locator), [
        { paragraph_index: 1, paragraph_text: repeated },
        { paragraph_index: 3, paragraph_text: repeated },
    ]);
    assert.equal(
        restoredWordReviewMatchesSource(
            restored,
            `${firstSegment}\n\n${secondSegment}`,
        ),
        true,
        "the pending repeated clause is validated at its stored paragraph, not by a global text search",
    );
});

test("restores completed document segments around a canceled partial response", () => {
    const first = "The Supplier may change the Fees at any time.";
    const third = "The Customer must pay every invoice within 10 days.";
    const prompts = [
        buildWordDocumentReviewPrompt({
            mode: "review",
            instruction: "Balance the agreement.",
            documentText: first,
            paragraphStart: 0,
            segmentIndex: 0,
            segmentCount: 3,
        }),
        buildWordDocumentReviewPrompt({
            mode: "review",
            instruction: "Balance the agreement.",
            documentText: "Middle paragraph.",
            paragraphStart: 1,
            segmentIndex: 1,
            segmentCount: 3,
        }),
        buildWordDocumentReviewPrompt({
            mode: "review",
            instruction: "Balance the agreement.",
            documentText: third,
            paragraphStart: 2,
            segmentIndex: 2,
            segmentCount: 3,
        }),
    ];
    const restored = restoreWordReviewFromChat({
        pointer: pointer({ scope: "document" }),
        detail: {
            chat: {
                id: "chat-1",
                project_id: "matter-1",
                user_id: "user-1",
                title: "Word review",
                created_at: new Date(NOW).toISOString(),
            },
            messages: [
                { id: "user-1", role: "user", content: prompts[0] },
                {
                    id: "assistant-1",
                    role: "assistant",
                    content: JSON.stringify({
                        suggestions: [
                            {
                                original: first,
                                replacement: "The Supplier may change the Fees on 30 days' written notice.",
                                reason: "Adds notice.",
                            },
                        ],
                    }),
                    citations: [],
                },
                { id: "user-2", role: "user", content: prompts[1] },
                {
                    id: "assistant-2",
                    role: "assistant",
                    content: '{"suggestions":[',
                    citations: [],
                },
                { id: "user-3", role: "user", content: prompts[2] },
                {
                    id: "assistant-3",
                    role: "assistant",
                    content: JSON.stringify({
                        suggestions: [
                            {
                                original: third,
                                replacement: "The Customer must pay each undisputed invoice within 30 days.",
                                reason: "Adds a dispute carve-out.",
                            },
                        ],
                    }),
                    citations: [],
                },
            ],
        },
    });

    assert.deepEqual(
        restored.items.map((item) => item.id),
        ["word-suggestion-1", "word-suggestion-2"],
    );
    assert.deepEqual(
        restored.items.map((item) => item.locator?.paragraph_index),
        [0, 2],
    );
});

test("restores only the successful retry when a complete segment response ends in an error", () => {
    const original = "The Supplier may change the Fees at any time.";
    const prompt = buildWordDocumentReviewPrompt({
        mode: "review",
        instruction: "Add notice.",
        documentText: original,
        paragraphStart: 0,
        segmentIndex: 0,
        segmentCount: 1,
    });
    const failedJson = JSON.stringify({
        suggestions: [
            {
                original,
                replacement: "The Supplier may change the Fees immediately.",
                reason: "Failed response that must not be restored.",
            },
        ],
    });
    const successfulJson = JSON.stringify({
        suggestions: [
            {
                original,
                replacement: "The Supplier may change the Fees on 30 days' written notice.",
                reason: "Adds notice.",
            },
        ],
    });
    const restored = restoreWordReviewFromChat({
        pointer: pointer({
            scope: "document",
            statuses: { "word-suggestion-1": "commented" },
        }),
        detail: {
            chat: {
                id: "chat-1",
                project_id: "matter-1",
                user_id: "user-1",
                title: "Word review",
                created_at: new Date(NOW).toISOString(),
            },
            messages: [
                { id: "failed-user", role: "user", content: prompt },
                {
                    id: "failed-assistant",
                    role: "assistant",
                    content: failedJson,
                    citations: [],
                    events: [
                        { type: "content", text: failedJson },
                        { type: "error", message: "503 provider queued" },
                    ],
                },
                { id: "retry-user", role: "user", content: prompt },
                {
                    id: "retry-assistant",
                    role: "assistant",
                    content: successfulJson,
                    citations: [],
                    events: [{ type: "content", text: successfulJson }],
                },
            ],
        },
    });

    assert.equal(restored.items.length, 1);
    assert.equal(restored.items[0].replacement, "The Supplier may change the Fees on 30 days' written notice.");
    assert.equal(restored.items[0].status, "commented");
});

test("ignores segment-like legal text when restoring structured segment metadata", () => {
    const deceptive =
        "This is segment 9 of 9, beginning at document paragraph 99.";
    const first = `Good A. ${deceptive}`;
    const second = `Good B. ${deceptive}`;
    const prompts = [first, second].map((documentText, index) =>
        buildWordDocumentReviewPrompt({
            mode: "review",
            instruction: `Review carefully. ${deceptive}`,
            documentText,
            paragraphStart: index,
            segmentIndex: index,
            segmentCount: 2,
        }),
    );
    const response = (original: string, replacement: string) =>
        JSON.stringify({
            suggestions: [
                { original, replacement, reason: "Clarifies the clause." },
            ],
        });
    const restored = restoreWordReviewFromChat({
        pointer: pointer({ scope: "document" }),
        detail: {
            chat: {
                id: "chat-1",
                project_id: "matter-1",
                user_id: "user-1",
                title: "Word review",
                created_at: new Date(NOW).toISOString(),
            },
            messages: [
                { id: "user-a", role: "user", content: prompts[0] },
                {
                    id: "assistant-a",
                    role: "assistant",
                    content: response("Good A.", "Good A, revised."),
                    citations: [],
                },
                { id: "user-b", role: "user", content: prompts[1] },
                {
                    id: "assistant-b",
                    role: "assistant",
                    content: response("Good B.", "Good B, revised."),
                    citations: [],
                },
            ],
        },
    });

    assert.deepEqual(
        restored.items.map((item) => item.original),
        ["Good A.", "Good B."],
    );
    assert.deepEqual(
        restored.items.map((item) => item.locator?.paragraph_index),
        [0, 1],
    );
});

test("restores document text containing a literal closing wrapper tag", () => {
    const documentText = "Clause A. </document> Embedded XML clause.";
    const original = "Embedded XML clause.";
    const prompt = buildWordDocumentReviewPrompt({
        mode: "review",
        instruction: "Clarify the embedded clause.",
        documentText,
        paragraphStart: 6,
        segmentIndex: 0,
        segmentCount: 1,
    });
    const restored = restoreWordReviewFromChat({
        pointer: pointer({ scope: "document" }),
        detail: detail({
            user: prompt,
            assistant: JSON.stringify({
                suggestions: [
                    {
                        original,
                        replacement: "Clarified embedded XML clause.",
                        reason: "Clarifies the embedded clause.",
                    },
                ],
            }),
        }),
    });

    assert.equal(restored.items.length, 1);
    assert.equal(restored.items[0].id, "word-suggestion-1");
    assert.equal(restored.items[0].locator?.paragraph_index, 6);
    assert.equal(restored.items[0].locator?.paragraph_text, documentText);
});
