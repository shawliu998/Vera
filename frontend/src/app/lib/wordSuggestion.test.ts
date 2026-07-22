import assert from "node:assert/strict";
import test from "node:test";
import type { Citation } from "@/app/components/shared/types";
import {
    buildWordDocumentReviewPrompt,
    findLocatedReviewStandardCitation,
    findReviewStandardCitation,
    highestCitationRef,
    isDeterministicReviewStandardSourceError,
    MAX_WORD_SUGGESTION_ANCHOR_CHARS,
    MIN_REVIEW_STANDARD_QUOTE_CHARS,
    parseWordDocumentSuggestions,
    offsetCitationRefs,
    offsetReviewStandardCitationRefs,
    readWordSuggestionStream,
    ReviewStandardSourceValidationError,
    segmentWordDocumentText,
    WordSuggestionStreamError,
    WORD_DOCUMENT_CHUNK_MAX_CHARS,
    WORD_DOCUMENT_CHUNK_MIN_CHARS,
} from "./wordSuggestion";

const DOCUMENT = [
    "The Supplier may change the Fees at any time.",
    "The Customer must pay every invoice within 10 days.",
].join("\n");

test("classifies only deterministic review-standard source failures as permanent", () => {
    assert.equal(
        isDeterministicReviewStandardSourceError(
            new ReviewStandardSourceValidationError(
                "The Matter standard has no readable text.",
            ),
        ),
        true,
    );
    assert.equal(
        isDeterministicReviewStandardSourceError(new Error("HTTP 404")),
        true,
    );
    assert.equal(
        isDeterministicReviewStandardSourceError({ status: 422 }),
        true,
    );
});

test("keeps transient review-standard source failures retryable", () => {
    assert.equal(
        isDeterministicReviewStandardSourceError(new Error("HTTP 429")),
        false,
    );
    assert.equal(
        isDeterministicReviewStandardSourceError(new Error("HTTP 503")),
        false,
    );
    assert.equal(
        isDeterministicReviewStandardSourceError(
            new TypeError("Failed to fetch"),
        ),
        false,
    );
    assert.equal(
        isDeterministicReviewStandardSourceError({ status: 401 }),
        false,
    );
});

test("buildWordDocumentReviewPrompt requests bounded exact-quote JSON", () => {
    const prompt = buildWordDocumentReviewPrompt({
        mode: "review",
        documentText: DOCUMENT,
        instruction: "Make the fees clause balanced.",
        documentTextTruncated: true,
    });

    assert.match(prompt, /0 to 5 items/);
    assert.match(prompt, /exact, verbatim, uniquely occurring short passage/);
    assert.match(prompt, /directly searchable in Word/);
    assert.match(prompt, /at most 255 characters/);
    assert.match(prompt, /replace exactly the quoted/);
    assert.match(prompt, /do not repeat text outside it/);
    assert.match(prompt, /at most one suggestion for each paragraph/);
    assert.match(prompt, /Only the first part of the document is available/);
    assert.match(prompt, /The Supplier may change the Fees/);
});

test("buildWordDocumentReviewPrompt requires a Matter standard for every suggestion", () => {
    const prompt = buildWordDocumentReviewPrompt({
        mode: "review",
        documentText: DOCUMENT,
        instruction: "Review against the firm's customer-side standard.",
        reviewStandard: { filename: "Customer Contract Playbook.docx" },
    });

    assert.match(prompt, /Customer Contract Playbook\.docx/);
    assert.match(prompt, /Read that document before suggesting a change/);
    assert.match(prompt, /"standard"/);
    assert.match(prompt, /"deviation"/);
    assert.match(prompt, /"standard_citation_ref"/);
    assert.match(prompt, /hidden <CITATIONS> block/);
    assert.match(prompt, /uniquely occurring quotation/);
    assert.match(
        prompt,
        new RegExp(`${MIN_REVIEW_STANDARD_QUOTE_CHARS} characters excluding whitespace`),
    );
});

test("segments a 60k Chinese Word document without splitting paragraphs or losing a post-20k clause", () => {
    const paragraphs = Array.from(
        { length: 60 },
        (_, index) => `${"第".repeat(1_100)}第${index + 1}条。`,
    );
    paragraphs[28] = "第二十九条：供应商应在变更费用前至少提前三十日书面通知客户。";
    const documentText = paragraphs.join("\r");
    const segments = segmentWordDocumentText(documentText);

    assert.ok(documentText.length > 60_000);
    assert.ok(segments.length > 3);
    const roundtripParagraphs = segments.flatMap((segment) =>
        segment.text.split("\n\n"),
    );
    assert.deepEqual(roundtripParagraphs, paragraphs);
    assert.ok(segments.every((segment) => segment.text.length <= 16_000));
    const target = segments.find((segment) =>
        segment.text.includes("供应商应在变更费用前"),
    );
    assert.ok(target);
    assert.ok(target.paragraphStart > 20);
});

test("adds a paragraph locator to a segment-local repeated standard clause", () => {
    const repeated = "本协议受中华人民共和国法律管辖。";
    const segment = `第一条。\n\n${repeated}\n\n第三条。`;
    const result = parseWordDocumentSuggestions(
        JSON.stringify({
            suggestions: [
                {
                    original: repeated,
                    replacement: "本协议受中华人民共和国法律管辖，并由上海法院专属管辖。",
                    reason: "Adds a forum selection.",
                },
            ],
        }),
        segment,
        { paragraphStart: 27, idOffset: 3 },
    );

    assert.equal(result[0].id, "word-suggestion-4");
    assert.deepEqual(result[0].locator, {
        paragraph_index: 28,
        paragraph_text: repeated,
    });
});

test("accepts an empty segment review when that segment needs no change", () => {
    assert.deepEqual(
        parseWordDocumentSuggestions('{"suggestions":[]}', "No change needed."),
        [],
    );
});

test("parseWordDocumentSuggestions accepts fenced JSON and creates stable ids", () => {
    const result = parseWordDocumentSuggestions(
        `\`\`\`json
{"suggestions":[
  {"original":"The Supplier may change the Fees at any time.","replacement":"The Supplier may change the Fees on 30 days' written notice.","reason":"Adds a defined notice period."},
  {"original":"The Customer must pay every invoice within 10 days.","replacement":"The Customer must pay each undisputed invoice within 30 days.","reason":"Adds a dispute carve-out and a workable payment period."}
]}
\`\`\``,
        DOCUMENT,
    );

    assert.equal(result.length, 2);
    assert.equal(result[0].id, "word-suggestion-1");
    assert.equal(result[1].original, "The Customer must pay every invoice within 10 days.");
});

test("parseWordDocumentSuggestions preserves a required Matter-standard mapping", () => {
    const result = parseWordDocumentSuggestions(
        JSON.stringify({
            suggestions: [
                {
                    original: "The Supplier may change the Fees at any time.",
                    replacement:
                        "The Supplier may change the Fees on 30 days' written notice.",
                    reason: "Adds a defined notice period.",
                    standard: "The playbook requires 30 days' prior notice.",
                    deviation: "The current clause allows changes at any time.",
                    standard_citation_ref: 2,
                },
            ],
        }),
        DOCUMENT,
        { requiresReviewStandard: true },
    );

    assert.equal(result[0].standard, "The playbook requires 30 days' prior notice.");
    assert.equal(result[0].deviation, "The current clause allows changes at any time.");
    assert.equal(result[0].standardCitationRef, 2);
});

test("parseWordDocumentSuggestions rejects an incomplete Matter-standard mapping", () => {
    assert.throws(
        () =>
            parseWordDocumentSuggestions(
                JSON.stringify({
                    suggestions: [
                        {
                            original: "The Supplier may change the Fees at any time.",
                            replacement:
                                "The Supplier may change the Fees on 30 days' written notice.",
                            reason: "Adds a defined notice period.",
                            standard: "The playbook requires 30 days' prior notice.",
                            deviation: "The current clause allows changes at any time.",
                        },
                    ],
                }),
                DOCUMENT,
                { requiresReviewStandard: true },
            ),
        /missing its review-standard explanation or citation/,
    );
});

test("findReviewStandardCitation matches only the mapped Matter source", () => {
    const citations: Citation[] = [
        {
            type: "citation_data",
            ref: 1,
            doc_id: "doc-0",
            document_id: "standard-1",
            version_id: "standard-v1",
            version_number: 1,
            filename: "Customer Contract Playbook.docx",
            page: 2,
            quote: "Supplier must give 30 days' notice.",
            quotes: [
                { page: 2, quote: "Supplier must give 30 days' notice." },
            ],
        },
        {
            type: "citation_data",
            ref: 2,
            doc_id: "doc-1",
            document_id: "other-document",
            filename: "Other source.docx",
            page: 1,
            quote: "Other source language.",
        },
        {
            type: "citation_data",
            ref: 3,
            doc_id: "doc-0",
            document_id: "standard-1",
            filename: "Customer Contract Playbook.docx",
            page: 2,
            quote: "",
        },
    ];

    assert.equal(
        findReviewStandardCitation(citations, "standard-1", 1)?.ref,
        1,
    );
    assert.equal(findReviewStandardCitation(citations, "standard-1", 2), null);
    assert.equal(findReviewStandardCitation(citations, "standard-1", 3), null);
    assert.equal(
        findReviewStandardCitation(
            [
                ...citations,
                {
                    type: "citation_data",
                    ref: 1,
                    doc_id: "doc-2",
                    document_id: "other-document",
                    filename: "Other source.docx",
                    page: 1,
                    quote: "A conflicting local ref.",
                },
            ],
            "standard-1",
            1,
        ),
        null,
        "a citation ref must identify exactly one source in a chat turn",
    );
});

test("requires a pinned, uniquely re-locatable Matter-standard quote before a Word write", () => {
    const citation: Citation = {
        type: "citation_data",
        ref: 1,
        doc_id: "doc-0",
        document_id: "standard-1",
        version_id: "standard-v1",
        version_number: 1,
        filename: "Customer Contract Playbook.docx",
        page: 2,
        quote:
            "Supplier must give at least 30 days' prior written notice before a fee change.",
    };
    const standardText = [
        "Customer Contract Playbook",
        "Supplier must give at least 30 days' prior written notice before a fee change.",
    ].join("\n\n");

    assert.equal(
        findLocatedReviewStandardCitation(
            [citation],
            "standard-1",
            1,
            standardText,
        )?.ref,
        1,
    );
    assert.equal(
        findLocatedReviewStandardCitation(
            [
                {
                    ...citation,
                    quote:
                        "The playbook requires an unavailable pricing protection.",
                },
            ],
            "standard-1",
            1,
            standardText,
        ),
        null,
        "a nonempty hallucinated quote must not allow a Word comment or tracked change",
    );
    assert.equal(
        findLocatedReviewStandardCitation(
            [citation],
            "standard-1",
            1,
            `${standardText}\n\n${citation.quote}`,
        ),
        null,
        "a repeated quotation is not a deterministic source anchor",
    );
    assert.equal(
        findReviewStandardCitation(
            [{ ...citation, version_id: null }],
            "standard-1",
            1,
        ),
        null,
        "the cited version must remain available to re-locate the source",
    );
});

test("offsets review-standard refs across independent document sections", () => {
    const citations: Citation[] = [
        {
            type: "citation_data",
            ref: 1,
            doc_id: "doc-0",
            document_id: "standard-1",
            filename: "Customer Contract Playbook.docx",
            page: 2,
            quote: "Supplier must give notice.",
        },
    ];
    const items = [
        {
            id: "word-suggestion-2",
            original: "Clause B.",
            replacement: "Clause B, revised.",
            reason: "Reason.",
            standardCitationRef: 1,
        },
    ];

    assert.equal(highestCitationRef(citations), 1);
    assert.equal(offsetCitationRefs(citations, 1)[0].ref, 2);
    assert.equal(
        offsetReviewStandardCitationRefs(items, 1)[0].standardCitationRef,
        2,
    );
});

test("parseWordDocumentSuggestions rejects a quote missing from the document", () => {
    assert.throws(
        () =>
            parseWordDocumentSuggestions(
                '{"suggestions":[{"original":"Missing clause.","replacement":"Replacement.","reason":"Reason."}]}',
                DOCUMENT,
            ),
        /no longer matches the loaded document/,
    );
});

test("parseWordDocumentSuggestions rejects ambiguous document quotes", () => {
    assert.throws(
        () =>
            parseWordDocumentSuggestions(
                '{"suggestions":[{"original":"Repeated.","replacement":"Changed.","reason":"Reason."}]}',
                "Repeated. Repeated.",
            ),
        /more than one passage/,
    );
});

test("parseWordDocumentSuggestions enforces the five-suggestion limit", () => {
    const suggestions = Array.from({ length: 6 }, (_, index) => ({
        original: `Clause ${index}.`,
        replacement: `Changed ${index}.`,
        reason: "Reason.",
    }));
    assert.throws(
        () =>
            parseWordDocumentSuggestions(
                JSON.stringify({ suggestions }),
                suggestions.map((item) => item.original).join(" "),
            ),
        /between 0 and 5/,
    );
});

test("parseWordDocumentSuggestions accepts a 255-character English Word anchor", () => {
    const original = "A".repeat(MAX_WORD_SUGGESTION_ANCHOR_CHARS);
    const result = parseWordDocumentSuggestions(
        JSON.stringify({
            suggestions: [
                {
                    original,
                    replacement: "Short replacement.",
                    reason: "Reason.",
                },
            ],
        }),
        original,
    );

    assert.deepEqual(result.map((item) => item.original), [original]);
});

test("parseWordDocumentSuggestions accepts a 255-character Chinese Word anchor", () => {
    const original = "条".repeat(MAX_WORD_SUGGESTION_ANCHOR_CHARS);
    const result = parseWordDocumentSuggestions(
        JSON.stringify({
            suggestions: [
                {
                    original,
                    replacement: "修订后的条款。",
                    reason: "明确付款义务。",
                },
            ],
        }),
        original,
    );

    assert.deepEqual(result.map((item) => item.original), [original]);
});

test("parseWordDocumentSuggestions rejects a 256-character English Word anchor when no valid item remains", () => {
    const original = "A".repeat(MAX_WORD_SUGGESTION_ANCHOR_CHARS + 1);
    assert.throws(
        () =>
            parseWordDocumentSuggestions(
                JSON.stringify({
                    suggestions: [
                        {
                            original,
                            replacement: "Short replacement.",
                            reason: "Reason.",
                        },
                    ],
                }),
                original,
            ),
        /No suggestion could be located.*more than 255 characters/,
    );
});

test("parseWordDocumentSuggestions rejects a 256-character Chinese Word anchor when no valid item remains", () => {
    const original = "条".repeat(MAX_WORD_SUGGESTION_ANCHOR_CHARS + 1);
    assert.throws(
        () =>
            parseWordDocumentSuggestions(
                JSON.stringify({
                    suggestions: [
                        {
                            original,
                            replacement: "修订后的条款。",
                            reason: "明确付款义务。",
                        },
                    ],
                }),
                original,
            ),
        /No suggestion could be located.*more than 255 characters/,
    );
});

test("parseWordDocumentSuggestions discards only an overlong anchor and preserves valid items", () => {
    const overlong = "A".repeat(MAX_WORD_SUGGESTION_ANCHOR_CHARS + 1);
    const valid = "The Customer must pay each undisputed invoice within 30 days.";
    const result = parseWordDocumentSuggestions(
        JSON.stringify({
            suggestions: [
                {
                    original: overlong,
                    replacement: "Replacement that must never be anchored by truncation.",
                    reason: "This quote exceeds Word's exact-search limit.",
                },
                {
                    original: valid,
                    replacement: "The Customer must pay each undisputed invoice within 45 days.",
                    reason: "Provides a more workable payment period.",
                },
            ],
        }),
        `${overlong}\n${valid}`,
    );

    assert.equal(result.length, 1);
    assert.equal(result[0].id, "word-suggestion-1");
    assert.equal(result[0].original, valid);
});

test("parseWordDocumentSuggestions rejects duplicate suggestion anchors", () => {
    const original = "The Supplier may change the Fees at any time.";
    assert.throws(
        () =>
            parseWordDocumentSuggestions(
                JSON.stringify({
                    suggestions: [
                        { original, replacement: "Replacement one.", reason: "Reason one." },
                        { original, replacement: "Replacement two.", reason: "Reason two." },
                    ],
                }),
                original,
            ),
        /repeats an earlier document passage/,
    );
});

test("parseWordDocumentSuggestions rejects multi-paragraph anchors", () => {
    const original = "First paragraph.\nSecond paragraph.";
    assert.throws(
        () =>
            parseWordDocumentSuggestions(
                JSON.stringify({
                    suggestions: [
                        { original, replacement: "Replacement.", reason: "Reason." },
                    ],
                }),
                original,
            ),
        /spans more than one paragraph/,
    );
});

test("parseWordDocumentSuggestions rejects a multi-paragraph document replacement", () => {
    const original = "The Supplier may change the Fees at any time.";
    assert.throws(
        () =>
            parseWordDocumentSuggestions(
                JSON.stringify({
                    suggestions: [
                        {
                            original,
                            replacement: "Replacement paragraph.\nSecond paragraph.",
                            reason: "Reason.",
                        },
                    ],
                }),
                original,
                { paragraphStart: 4 },
            ),
        /replaces more than one paragraph/,
    );
});

test("parseWordDocumentSuggestions rejects two changes in one document paragraph", () => {
    const first = "The Supplier may change the Fees";
    const second = "without prior notice";
    const paragraph = `${first} ${second}.`;
    assert.throws(
        () =>
            parseWordDocumentSuggestions(
                JSON.stringify({
                    suggestions: [
                        {
                            original: first,
                            replacement: "The Supplier may adjust the Fees",
                            reason: "Uses a more precise verb.",
                        },
                        {
                            original: second,
                            replacement: "on 30 days' prior written notice",
                            reason: "Adds notice.",
                        },
                    ],
                }),
                paragraph,
                { paragraphStart: 8 },
            ),
        /second change to the same paragraph/,
    );
});

test("parseWordDocumentSuggestions rejects overlapping anchors", () => {
    const documentText = "The Supplier may change the Fees on written notice.";
    assert.throws(
        () =>
            parseWordDocumentSuggestions(
                JSON.stringify({
                    suggestions: [
                        {
                            original: "The Supplier may change the Fees",
                            replacement: "The Supplier may adjust the Fees",
                            reason: "Reason one.",
                        },
                        {
                            original: "change the Fees on written notice",
                            replacement: "change the Fees on 30 days' written notice",
                            reason: "Reason two.",
                        },
                    ],
                }),
                documentText,
            ),
        /overlaps an earlier suggestion/,
    );
});

test("readWordSuggestionStream discards progress text emitted before a tool call", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(
                encoder.encode(
                    [
                        'data: {"type":"content_delta","text":"Let me check the project documents."}',
                        'data: {"type":"tool_call_start","name":"search_documents"}',
                        'data: {"type":"content_delta","text":"The Supplier may change the Fees "}',
                        `data: ${JSON.stringify({ type: "content_delta", text: "on 30 days' written notice." })}`,
                        "data: [DONE]",
                        "",
                    ].join("\n\n"),
                ),
            );
            controller.close();
        },
    });
    const snapshots: string[] = [];
    const result = await readWordSuggestionStream(
        new Response(stream, { status: 200 }),
        (text) => snapshots.push(text),
    );

    assert.equal(
        result.text,
        "The Supplier may change the Fees on 30 days' written notice.",
    );
    assert.deepEqual(snapshots, [
        "Let me check the project documents.",
        "",
        "The Supplier may change the Fees ",
        "The Supplier may change the Fees on 30 days' written notice.",
    ]);
});

test("readWordSuggestionStream preserves the Matter chat id on a queued stream error", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(
                encoder.encode(
                    [
                        'data: {"type":"chat_id","chatId":"chat-queued"}',
                        'data: {"type":"error","message":"503 provider queued"}',
                        "",
                    ].join("\n\n"),
                ),
            );
            controller.close();
        },
    });

    await assert.rejects(
        () => readWordSuggestionStream(new Response(stream, { status: 200 })),
        (error: unknown) => {
            assert.ok(error instanceof WordSuggestionStreamError);
            assert.equal(error.chatId, "chat-queued");
            assert.match(error.message, /503 provider queued/);
            return true;
        },
    );
});

test("readWordSuggestionStream includes a queued HTTP status in its error", async () => {
    await assert.rejects(
        () =>
            readWordSuggestionStream(
                new Response("Provider is temporarily unavailable", {
                    status: 503,
                }),
            ),
        (error: unknown) => {
            assert.ok(error instanceof WordSuggestionStreamError);
            assert.equal(error.status, 503);
            assert.match(error.message, /503/);
            return true;
        },
    );
});

test("segmentWordDocumentText keeps paragraphs whole and within bounds", () => {
    const paragraph = "The Supplier may change the Fees at any time.";
    const paragraphs = Array.from({ length: 400 }, () => paragraph);
    const documentText = paragraphs.join("\r");
    const segments = segmentWordDocumentText(documentText);

    assert.ok(segments.length > 1);
    for (const segment of segments) {
        assert.ok(
            segment.text.length <= WORD_DOCUMENT_CHUNK_MAX_CHARS,
            `segment ${segment.index} exceeds max`,
        );
    }
    assert.ok(
        segments.slice(0, -1).every(
            (segment) => segment.text.length >= WORD_DOCUMENT_CHUNK_MIN_CHARS,
        ),
        "all but the last segment meet the minimum",
    );
});

test("leading empty Word paragraphs preserve the live paragraph index", () => {
    const documentText = "\r\rClause A.";
    const segments = segmentWordDocumentText(documentText);
    assert.deepEqual(
        segments.flatMap((segment) => segment.text.split("\n\n")),
        ["", "", "Clause A."],
    );
    const suggestions = parseWordDocumentSuggestions(
        JSON.stringify({
            suggestions: [
                {
                    original: "Clause A.",
                    replacement: "Clause A, revised.",
                    reason: "Clarifies the clause.",
                },
            ],
        }),
        segments[0].text,
        { paragraphStart: segments[0].paragraphStart },
    );
    assert.equal(suggestions[0].locator?.paragraph_index, 2);
    assert.equal(suggestions[0].locator?.paragraph_text, "Clause A.");
});

test("segmentWordDocumentText places a clause after character 20k outside the first segment", () => {
    const filler = "本条款为合同一般条款，适用于双方约定的各项服务。";
    const targetClause = "目标条款：客户有权在新费用生效前无责解除本协议。";
    const paragraphs: string[] = [];
    let length = 0;
    while (length < 22_000) {
        paragraphs.push(filler);
        length += filler.length + 2;
    }
    paragraphs.push(targetClause);
    const documentText = paragraphs.join("\r");
    const segments = segmentWordDocumentText(documentText);

    assert.ok(segments.length > 1);
    assert.ok(segments[0].paragraphStart === 0);
    assert.ok(segments[0].paragraphEnd < paragraphs.length - 1);
    const targetSegment = segments.find((segment) =>
        segment.text.includes(targetClause),
    );
    assert.ok(targetSegment);
    assert.ok(targetSegment!.index > 0);
});

test("segmentWordDocumentText blocks an unsafe paragraph larger than the model segment", () => {
    assert.throws(
        () => segmentWordDocumentText("条".repeat(WORD_DOCUMENT_CHUNK_MAX_CHARS + 1)),
        /paragraph is longer than 16,000 characters.*Selected text/,
    );
});

test("parseWordDocumentSuggestions assigns chunk ids and paragraph locators", () => {
    const chunkText = [
        "The Supplier may change the Fees at any time.",
        "The Customer must pay every invoice within 10 days.",
    ].join("\n\n");
    const result = parseWordDocumentSuggestions(
        JSON.stringify({
            suggestions: [
                {
                    original: "The Supplier may change the Fees at any time.",
                    replacement: "The Supplier may change the Fees on 30 days' written notice.",
                    reason: "Adds a defined notice period.",
                },
            ],
        }),
        chunkText,
        { idOffset: 5, paragraphStart: 10 },
    );

    assert.equal(result.length, 1);
    assert.equal(result[0].id, "word-suggestion-6");
    assert.equal(result[0].locator?.paragraph_index, 10);
});

test("buildWordDocumentReviewPrompt includes segment metadata", () => {
    const prompt = buildWordDocumentReviewPrompt({
        mode: "review",
        documentText: "Clause one.\n\nClause two.",
        instruction: "Balance terms.",
        paragraphStart: 4,
        segmentIndex: 1,
        segmentCount: 3,
    });

    assert.match(prompt, /segment 2 of 3/);
    assert.match(prompt, /paragraph 5/);
    assert.match(
        prompt,
        /<vera_word_segment index="1" count="3" paragraph_start="4" source_chars="24" \/>/,
    );
    assert.match(prompt, /Only review this supplied segment/);
});
