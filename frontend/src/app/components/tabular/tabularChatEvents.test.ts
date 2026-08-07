import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantEvent } from "../shared/types";
import {
    appendAssistantEvent,
    appendReasoningDelta,
    appendThinkingPlaceholder,
    ensureStreamingContentEvent,
    parseCourtlistenerCaseSearches,
    parseCourtlistenerEventCases,
    replaceLastAssistantEvents,
    updateLastAssistantContent,
    updateLastContentEvent,
    updateLastMatchingEvent,
    withoutStreamingPlaceholders,
    type TRMessage,
} from "./tabularChatEvents";

test("mirrors dripped content into the event snapshot used by later events", () => {
    const initial: AssistantEvent[] = [
        { type: "content", text: "", isStreaming: true },
    ];
    const dripped = updateLastContentEvent(initial, "已显示的结论", true);
    const withToolEvent = appendAssistantEvent(dripped, {
        type: "doc_read",
        filename: "合同.docx",
        isStreaming: true,
    });
    const messages: TRMessage[] = [
        { role: "user", content: "总结" },
        { role: "assistant", content: "", events: initial },
    ];
    const published = replaceLastAssistantEvents(messages, withToolEvent);

    assert.deepEqual(published.at(-1)?.events, [
        { type: "content", text: "已显示的结论", isStreaming: true },
        { type: "doc_read", filename: "合同.docx", isStreaming: true },
    ]);
});

test("updates visible content without mutating history when no assistant is last", () => {
    const assistant: TRMessage[] = [
        {
            role: "assistant",
            content: "",
            events: [{ type: "content", text: "旧", isStreaming: true }],
        },
    ];
    const updated = updateLastAssistantContent(assistant, "新", true);
    assert.notEqual(updated, assistant);
    assert.equal(
        (updated[0].events?.[0] as { type: "content"; text: string }).text,
        "新",
    );

    const user: TRMessage[] = [{ role: "user", content: "继续" }];
    assert.equal(updateLastAssistantContent(user, "ignored"), user);

    const noContent: TRMessage[] = [
        { role: "assistant", content: "", events: [] },
    ];
    assert.equal(updateLastAssistantContent(noContent, "ignored"), noContent);
});

test("placeholder bridges are unique and disappear before real events", () => {
    const base: AssistantEvent[] = [{ type: "reasoning", text: "完成" }];
    const once = appendThinkingPlaceholder(base);
    assert.equal(appendThinkingPlaceholder(once), once);
    const withRealEvent = appendAssistantEvent(once, {
        type: "doc_read",
        filename: "证据.pdf",
    });
    assert.equal(withRealEvent.some((event) => event.type === "thinking"), false);
    assert.equal(withoutStreamingPlaceholders(base), base);
});

test("reasoning and content transitions retain completed text", () => {
    const started = appendReasoningDelta([], "先核对");
    const continued = appendReasoningDelta(started, "来源");
    const content = ensureStreamingContentEvent(continued);
    assert.deepEqual(content, [
        { type: "reasoning", text: "先核对来源" },
        { type: "content", text: "", isStreaming: true },
    ]);
    assert.equal(ensureStreamingContentEvent(content), content);
});

test("finalizes only the most recent matching streaming event", () => {
    const input: AssistantEvent[] = [
        { type: "doc_read", filename: "A.docx", isStreaming: true },
        { type: "doc_read", filename: "B.docx", isStreaming: true },
    ];
    const result = updateLastMatchingEvent(
        input,
        (event) => event.type === "doc_read" && !!event.isStreaming,
        (event) => ({ ...event, isStreaming: false }),
    );
    assert.equal(result.matched, true);
    assert.equal(
        result.events[0].type === "doc_read" &&
            result.events[0].isStreaming,
        true,
    );
    assert.equal(
        result.events[1].type === "doc_read" &&
            result.events[1].isStreaming,
        false,
    );
});

test("normalizes CourtListener payloads and rejects unusable cases", () => {
    assert.deepEqual(
        parseCourtlistenerEventCases([
            { cluster_id: 42, case_name: "示例案", citation: "1 F.3d 2" },
            { cluster_id: 0, case_name: "无效" },
            "bad",
        ]),
        [
            {
                cluster_id: 42,
                case_name: "示例案",
                citation: "1 F.3d 2",
                dateFiled: null,
                url: null,
            },
        ],
    );
    assert.deepEqual(parseCourtlistenerCaseSearches([{ query: 7 }]), [
        {
            cluster_id: null,
            query: "",
            total_matches: 0,
            case_name: null,
            citation: null,
            error: undefined,
        },
    ]);
});
