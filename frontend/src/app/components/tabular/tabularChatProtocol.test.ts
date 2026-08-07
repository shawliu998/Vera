import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantEvent } from "../shared/types";
import {
    parseTabularCitationAnnotations,
    reduceTabularToolEvent,
} from "./tabularChatProtocol";

test("accepts only complete Tabular citation annotations", () => {
    assert.deepEqual(
        parseTabularCitationAnnotations([
            {
                type: "tabular_citation",
                ref: 1,
                col_index: 2,
                row_index: 3,
                col_name: "适用法律",
                doc_name: "合同.docx",
                quote: "适用中华人民共和国法律",
            },
            { type: "tabular_citation", ref: "bad" },
            null,
        ]),
        [
            {
                type: "tabular_citation",
                ref: 1,
                col_index: 2,
                row_index: 3,
                col_name: "适用法律",
                doc_name: "合同.docx",
                quote: "适用中华人民共和国法律",
            },
        ],
    );
});

test("transitions a matching CourtListener search from streaming to complete", () => {
    const start = reduceTabularToolEvent([], {
        type: "courtlistener_search_case_law_start",
        query: "合同解释",
    });
    const complete = reduceTabularToolEvent(start.events, {
        type: "courtlistener_search_case_law",
        query: "合同解释",
        result_count: 3,
    });

    assert.equal(start.handled, true);
    assert.deepEqual(complete.events, [
        {
            type: "courtlistener_search_case_law",
            query: "合同解释",
            result_count: 3,
            error: undefined,
            isStreaming: false,
        },
        { type: "thinking", isStreaming: true },
    ]);
});

for (const scenario of [
    {
        name: "case collection",
        eventType: "courtlistener_get_cases",
        start: {
            type: "courtlistener_get_cases_start",
            cluster_ids: [1, "bad"],
        },
        finish: {
            type: "courtlistener_get_cases",
            cluster_ids: [1],
            case_count: 1,
            opinion_count: 2,
            cases: [{ cluster_id: 1, case_name: "A" }],
        },
    },
    {
        name: "in-case search",
        eventType: "courtlistener_find_in_case",
        start: {
            type: "courtlistener_find_in_case_start",
            cluster_id: 2,
            query: "违约",
        },
        finish: {
            type: "courtlistener_find_in_case",
            cluster_id: 2,
            query: "违约",
            total_matches: 4,
        },
    },
    {
        name: "case read",
        eventType: "courtlistener_read_case",
        start: { type: "courtlistener_read_case_start", cluster_id: 3 },
        finish: {
            type: "courtlistener_read_case",
            cluster_id: 3,
            opinion_count: 1,
        },
    },
    {
        name: "citation verification",
        eventType: "courtlistener_verify_citations",
        start: {
            type: "courtlistener_verify_citations_start",
            citation_count: 5,
        },
        finish: {
            type: "courtlistener_verify_citations",
            citation_count: 5,
            match_count: 4,
        },
    },
] as const) {
    test(`transitions ${scenario.name} tool events without losing identity`, () => {
        const started = reduceTabularToolEvent([], scenario.start);
        const finished = reduceTabularToolEvent(started.events, scenario.finish);
        assert.equal(finished.handled, true);
        assert.equal(finished.events[0].type, scenario.eventType);
        assert.equal(
            "isStreaming" in finished.events[0]
                ? finished.events[0].isStreaming
                : undefined,
            false,
        );
        assert.deepEqual(finished.events.at(-1), {
            type: "thinking",
            isStreaming: true,
        });
    });
}

test("does not complete a different document read and still bridges progress", () => {
    const events: AssistantEvent[] = [
        { type: "doc_read", filename: "A.docx", isStreaming: true },
    ];
    const result = reduceTabularToolEvent(events, {
        type: "doc_read",
        filename: "B.docx",
    });
    assert.deepEqual(result.events, [
        { type: "doc_read", filename: "A.docx", isStreaming: true },
        { type: "thinking", isStreaming: true },
    ]);
});

test("rejects malformed document and case-opinion payloads without mutation", () => {
    const events: AssistantEvent[] = [{ type: "content", text: "保留" }];
    const badDocument = reduceTabularToolEvent(events, {
        type: "doc_read_start",
        filename: 7,
    });
    const badCase = reduceTabularToolEvent(events, {
        type: "case_opinions",
        cluster_id: 1,
        case: { opinions: "not-an-array" },
    });
    assert.equal(badDocument.events, events);
    assert.equal(badCase.events, events);
});

test("normalizes case opinions before exposing them to rendering", () => {
    const result = reduceTabularToolEvent([], {
        type: "case_opinions",
        cluster_id: 9,
        case: {
            id: 9,
            caseName: "示例案",
            citations: ["1 F.3d 2", 8],
            opinions: [
                { opinionId: 10, type: "lead", author: "Judge", url: 4 },
                "bad",
            ],
        },
    });
    assert.deepEqual(result.events, [
        {
            type: "case_opinions",
            cluster_id: 9,
            case: {
                id: 9,
                caseName: "示例案",
                dateFiled: null,
                citations: ["1 F.3d 2"],
                url: null,
                pdfUrl: null,
                opinions: [
                    {
                        opinionId: 10,
                        apiUrl: null,
                        type: "lead",
                        author: "Judge",
                        url: null,
                        text: null,
                        html: null,
                    },
                ],
            },
        },
    ]);
});

test("leaves unrelated protocol events for the component dispatcher", () => {
    const events: AssistantEvent[] = [];
    const result = reduceTabularToolEvent(events, {
        type: "content_delta",
        text: "结论",
    });
    assert.equal(result.handled, false);
    assert.equal(result.events, events);
});
