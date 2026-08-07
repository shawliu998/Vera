import assert from "node:assert/strict";
import test from "node:test";

import {
    finishTabularChatSession,
    startTabularChatSession,
} from "./tabularChatSession";
import type { TRMessage } from "./tabularChatEvents";

test("starts with plain history and one optimistic assistant turn", () => {
    const history: TRMessage[] = [
        {
            role: "assistant",
            content: "此前答复",
            events: [{ type: "content", text: "此前答复" }],
        },
    ];
    const result = startTabularChatSession(history, "继续核对");
    assert.deepEqual(result.requestMessages, [
        { role: "assistant", content: "此前答复" },
        { role: "user", content: "继续核对" },
    ]);
    assert.deepEqual(result.optimisticMessages.at(-1), {
        role: "assistant",
        content: "",
        events: [],
        isStreaming: true,
    });
    assert.equal(history.length, 1);
});

test("preserves the full received tail when transport fails mid-drip", () => {
    const messages: TRMessage[] = [
        { role: "user", content: "总结" },
        {
            role: "assistant",
            content: "",
            events: [
                { type: "content", text: "已经显示", isStreaming: true },
                { type: "thinking", isStreaming: true },
            ],
            isStreaming: true,
        },
    ];
    const result = finishTabularChatSession(
        messages,
        messages[1].events ?? [],
        "已经显示并已接收的尾部",
        "failed",
    );
    assert.deepEqual(result.at(-1), {
        role: "assistant",
        content: "",
        events: [{ type: "content", text: "已经显示并已接收的尾部" }],
        isStreaming: false,
    });
});

test("adds a retry message only when a failed turn has no content", () => {
    const messages: TRMessage[] = [
        { role: "assistant", content: "", events: [], isStreaming: true },
    ];
    const failed = finishTabularChatSession(messages, [], "", "failed");
    const aborted = finishTabularChatSession(messages, [], "", "aborted");
    assert.deepEqual(failed.at(-1)?.events, [
        { type: "content", text: "An error occurred. Please try again." },
    ]);
    assert.deepEqual(aborted.at(-1)?.events, [
        { type: "content", text: "" },
    ]);
});

test("normal completion removes only transient thinking placeholders", () => {
    const messages: TRMessage[] = [
        {
            role: "assistant",
            content: "",
            events: [],
            isStreaming: true,
        },
    ];
    const result = finishTabularChatSession(
        messages,
        [
            { type: "reasoning", text: "核对完成" },
            { type: "thinking", isStreaming: true },
            { type: "content", text: "结论", isStreaming: true },
        ],
        "结论",
        "complete",
    );
    assert.deepEqual(result.at(-1), {
        role: "assistant",
        content: "",
        events: [
            { type: "reasoning", text: "核对完成" },
            { type: "content", text: "结论" },
        ],
        isStreaming: false,
    });
});
