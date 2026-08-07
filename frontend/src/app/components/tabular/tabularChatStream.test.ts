import assert from "node:assert/strict";
import test from "node:test";

import {
    iterateTabularChatEvents,
    type TabularChatStreamEvent,
} from "./tabularChatStream";

async function collect(response: Response) {
    const events: TabularChatStreamEvent[] = [];
    for await (const event of iterateTabularChatEvents(response)) {
        events.push(event);
    }
    return events;
}

test("parses split SSE frames and skips malformed or untyped payloads", async () => {
    const encoder = new TextEncoder();
    const response = new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(
                    encoder.encode(
                        'data: {"type":"reasoning_delta","text":"核',
                    ),
                );
                controller.enqueue(
                    encoder.encode(
                        '对"}\r\ndata: not-json\n\ndata: {"text":"missing type"}\n\ndata: [DONE]\n\n',
                    ),
                );
                controller.close();
            },
        }),
    );

    assert.deepEqual(await collect(response), [
        { type: "reasoning_delta", text: "核对" },
    ]);
});

test("emits a valid final frame even when the stream has no trailing newline", async () => {
    const response = new Response(
        'data: {"type":"content_delta","text":"结论"}',
    );
    assert.deepEqual(await collect(response), [
        { type: "content_delta", text: "结论" },
    ]);
});

test("preserves emitted events before propagating a transport interruption", async () => {
    const encoder = new TextEncoder();
    let pullCount = 0;
    const response = new Response(
        new ReadableStream<Uint8Array>({
            pull(controller) {
                if (pullCount === 0) {
                    pullCount += 1;
                    controller.enqueue(
                        encoder.encode(
                            'data: {"type":"content_delta","text":"已完成"}\n\n',
                        ),
                    );
                    return;
                }
                controller.error(new Error("connection lost"));
            },
        }),
    );
    const events: TabularChatStreamEvent[] = [];

    await assert.rejects(async () => {
        for await (const event of iterateTabularChatEvents(response)) {
            events.push(event);
        }
    }, /connection lost/);
    assert.deepEqual(events, [
        { type: "content_delta", text: "已完成" },
    ]);
});
