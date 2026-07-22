import assert from "node:assert/strict";
import {
    AmbiguousWordAnchorError,
    detectWordHost,
    OfficeJsWordHost,
    readCurrentWordDocumentFile,
    ReadOnlyWordDocumentError,
    StaleWordAnchorError,
    UnsupportedWordRegionError,
    type OfficeJsRuntime,
    type OfficeJsWordRuntime,
    type WordCitationAnchor,
} from "./wordOfficeBridge";

type FakeRange = {
    text: string;
    parentBody: { type: string; load: (properties: string) => void };
    load: (properties: string) => void;
    search?: (text: string) => { items: FakeRange[]; load: () => void };
    insertText: (text: string, location: unknown) => void;
    insertComment: (text: string) => void;
    select?: () => void;
};

function officeRuntime(maxWordApi = 1.6): OfficeJsRuntime {
    return {
        onReady: async () => ({ host: "Word", platform: "Mac" }),
        context: {
            document: {
                getSelectedDataAsync: (_coercionType, callback) =>
                    callback({ status: "succeeded", value: "selected" }),
            },
            requirements: {
                isSetSupported: (name, version) =>
                    name === "WordApi" && Number(version) <= maxWordApi,
            },
        },
        AsyncResultStatus: { Succeeded: "succeeded" },
    };
}

function fakeRange(args: {
    text: string;
    region?: string;
    onInsertText?: (text: string) => void;
    onInsertComment?: (text: string) => void;
    onSelect?: () => void;
}): FakeRange {
    return {
        text: args.text,
        parentBody: {
            type: args.region ?? "MainDoc",
            load: () => undefined,
        },
        load: () => undefined,
        insertText: (text) => args.onInsertText?.(text),
        insertComment: (text) => args.onInsertComment?.(text),
        ...(args.onSelect ? { select: args.onSelect } : {}),
    };
}

function wordRuntime(args: {
    selection?: FakeRange;
    matches?: FakeRange[];
    paragraphs?: FakeRange[];
    documentLoads?: string[];
    runCalls?: { count: number };
    trackedChanges?: Array<{
        author?: string;
        date?: string;
        text?: string;
        type?: string;
    }>;
}): OfficeJsWordRuntime {
    const selection = args.selection ?? fakeRange({ text: "selected" });
    const body = {
        type: "MainDoc",
        text: "document text",
        load: () => undefined,
        paragraphs: args.paragraphs
            ? { items: args.paragraphs, load: () => undefined }
            : undefined,
        search: () => ({
            items: args.matches ?? [],
            load: () => undefined,
        }),
        getTrackedChanges: () => ({
            items: args.trackedChanges ?? [],
            load: () => undefined,
        }),
    };
    const documentRuntime = {
        body,
        changeTrackingMode: "Off",
        load: (properties: string) => {
            args.documentLoads?.push(properties);
        },
        getSelection: () => selection,
    };

    const run: OfficeJsWordRuntime["run"] = async (callback) => {
        if (args.runCalls) args.runCalls.count += 1;
        return callback({
            document: documentRuntime,
            sync: async () => undefined,
        });
    };

    return {
        InsertLocation: { replace: "Replace" },
        run,
    };
}

const DOCUMENT_ANCHOR: WordCitationAnchor = {
    id: "citation-anchor-1",
    exact_quote: "target clause",
    locator: { scope: "document", region: "MainDoc" },
};

async function expectRejectsWith<T extends Error>(
    action: () => Promise<unknown>,
    errorType: new (...args: never[]) => T,
    code: string,
): Promise<T> {
    try {
        await action();
    } catch (error) {
        assert.ok(error instanceof errorType);
        assert.equal((error as { code?: string }).code, code);
        return error;
    }
    assert.fail(`Expected ${errorType.name}`);
}

async function run(): Promise<void> {
    const documentBytes = [
        Uint8Array.from([80, 75, 3]),
        Uint8Array.from([4, 20, 26]),
    ];
    const requestedSlices: number[] = [];
    let closeCount = 0;
    const fileRuntime = officeRuntime();
    fileRuntime.FileType = { Compressed: "compressed-docx" };
    fileRuntime.context!.document!.getFileAsync = (
        fileType,
        options,
        callback,
    ) => {
        assert.equal(fileType, "compressed-docx");
        assert.equal(options.sliceSize, 4 * 1024 * 1024);
        callback({
            status: "succeeded",
            value: {
                sliceCount: documentBytes.length,
                getSliceAsync: (
                    index: number,
                    sliceCallback: (result: {
                        status: unknown;
                        value?: unknown;
                    }) => void,
                ) => {
                    requestedSlices.push(index);
                    sliceCallback({
                        status: "succeeded",
                        value: { data: documentBytes[index] },
                    });
                },
                closeAsync: (
                    closeCallback: (result: { status: unknown }) => void,
                ) => {
                    closeCount += 1;
                    closeCallback({ status: "succeeded" });
                },
            },
        });
    };
    const exportedDocument = await readCurrentWordDocumentFile({
        filename: "Matter draft.docx",
        runtime: fileRuntime,
    });
    assert.equal(exportedDocument.name, "Matter draft.docx");
    assert.equal(
        exportedDocument.type,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    assert.deepEqual(
        Array.from(new Uint8Array(await exportedDocument.arrayBuffer())),
        [80, 75, 3, 4, 20, 26],
    );
    assert.deepEqual(requestedSlices, [0, 1]);
    assert.equal(closeCount, 1);

    let failedFileClosed = false;
    const failedSliceRuntime = officeRuntime();
    failedSliceRuntime.context!.document!.getFileAsync = (
        _fileType,
        _options,
        callback,
    ) => {
        callback({
            status: "succeeded",
            value: {
                sliceCount: 1,
                getSliceAsync: (
                    _index: number,
                    sliceCallback: (result: {
                        status: unknown;
                        error?: { message?: string };
                    }) => void,
                ) =>
                    sliceCallback({
                        status: "failed",
                        error: { message: "Host could not read this slice." },
                    }),
                closeAsync: (
                    closeCallback: (result: { status: unknown }) => void,
                ) => {
                    failedFileClosed = true;
                    closeCallback({ status: "succeeded" });
                },
            },
        });
    };
    await assert.rejects(
        () =>
            readCurrentWordDocumentFile({
                filename: "Matter draft.docx",
                runtime: failedSliceRuntime,
            }),
        /Host could not read this slice/,
    );
    assert.equal(failedFileClosed, true);

    const boundRuntime = officeRuntime();
    boundRuntime.onReady = async function () {
        assert.equal(this, boundRuntime);
        return { host: "Word", platform: "Mac" };
    };
    const detectedHost = await detectWordHost(boundRuntime, 50);
    assert.equal(detectedHost.kind, "word");

    const staleHost = new OfficeJsWordHost(
        officeRuntime(),
        wordRuntime({ matches: [] }),
    );
    await expectRejectsWith(
        () => staleHost.locate(DOCUMENT_ANCHOR),
        StaleWordAnchorError,
        "ANCHOR_STALE",
    );

    let staleSelectCount = 0;
    const staleSelectionHost = new OfficeJsWordHost(
        officeRuntime(),
        wordRuntime({
            selection: fakeRange({
                text: "The selection moved.",
                onSelect: () => {
                    staleSelectCount += 1;
                },
            }),
        }),
    );
    await expectRejectsWith(
        () =>
            staleSelectionHost.locate(
                {
                    exact_quote: DOCUMENT_ANCHOR.exact_quote,
                    locator: { scope: "selection" },
                },
                { select: true },
            ),
        StaleWordAnchorError,
        "ANCHOR_STALE",
    );
    assert.equal(
        staleSelectCount,
        0,
        "a stale selection must fail closed before Word changes its selection",
    );

    let selectedRangeCount = 0;
    const selectableHost = new OfficeJsWordHost(
        officeRuntime(),
        wordRuntime({
            matches: [
                fakeRange({
                    text: DOCUMENT_ANCHOR.exact_quote,
                    onSelect: () => {
                        selectedRangeCount += 1;
                    },
                }),
            ],
        }),
    );
    assert.deepEqual(
        await selectableHost.locate(DOCUMENT_ANCHOR, { select: true }),
        {
            anchor: DOCUMENT_ANCHOR,
            text: DOCUMENT_ANCHOR.exact_quote,
            region: "main-document",
        },
        "a successful user-requested locate selects the exact Word range",
    );
    assert.equal(selectedRangeCount, 1);

    let ambiguousSelectCount = 0;
    const ambiguousHost = new OfficeJsWordHost(
        officeRuntime(),
        wordRuntime({
            matches: [
                fakeRange({
                    text: DOCUMENT_ANCHOR.exact_quote,
                    onSelect: () => {
                        ambiguousSelectCount += 1;
                    },
                }),
                fakeRange({
                    text: DOCUMENT_ANCHOR.exact_quote,
                    onSelect: () => {
                        ambiguousSelectCount += 1;
                    },
                }),
            ],
        }),
    );
    const initialAmbiguous = await expectRejectsWith(
        () => ambiguousHost.locate(DOCUMENT_ANCHOR, { select: true }),
        AmbiguousWordAnchorError,
        "ANCHOR_AMBIGUOUS",
    );
    assert.equal(initialAmbiguous.matchCount, 2);
    assert.equal(
        ambiguousSelectCount,
        0,
        "an ambiguous anchor must fail closed before Word changes its selection",
    );

    const repeated = "Repeated standard clause.";
    const paragraphLocatedHost = new OfficeJsWordHost(
        officeRuntime(),
        wordRuntime({
            matches: [
                fakeRange({ text: repeated }),
                fakeRange({ text: repeated }),
            ],
            paragraphs: [
                fakeRange({ text: "Opening paragraph." }),
                {
                    ...fakeRange({ text: repeated }),
                    search: () => ({
                        items: [fakeRange({ text: repeated })],
                        load: () => undefined,
                    }),
                },
            ],
        }),
    );
    assert.deepEqual(
        await paragraphLocatedHost.locate({
            exact_quote: repeated,
            locator: {
                scope: "document",
                paragraph_index: 1,
                paragraph_text: repeated,
            },
        }),
        {
            anchor: {
                exact_quote: repeated,
                locator: {
                    scope: "document",
                    paragraph_index: 1,
                    paragraph_text: repeated,
                },
            },
            text: repeated,
            region: "main-document",
        },
        "a paragraph position must disambiguate a repeated clause without widening the exact quote",
    );

    const driftedParagraph = fakeRange({ text: `New context. ${repeated}` });
    const driftedParagraphHost = new OfficeJsWordHost(
        officeRuntime(),
        wordRuntime({
            paragraphs: [
                {
                    ...driftedParagraph,
                    search: () => ({
                        items: [fakeRange({ text: repeated })],
                        load: () => undefined,
                    }),
                },
            ],
        }),
    );
    await expectRejectsWith(
        () =>
            driftedParagraphHost.locate({
                exact_quote: repeated,
                locator: {
                    scope: "document",
                    paragraph_index: 0,
                    paragraph_text: `Original context. ${repeated}`,
                },
            }),
        StaleWordAnchorError,
        "ANCHOR_STALE",
    );

    const tableCellAnchor: WordCitationAnchor = {
        exact_quote: DOCUMENT_ANCHOR.exact_quote,
        locator: { scope: "document", region: "TableCell" },
    };
    const tableCellHost = new OfficeJsWordHost(
        officeRuntime(),
        wordRuntime({
            matches: [
                fakeRange({
                    text: DOCUMENT_ANCHOR.exact_quote,
                    region: "TableCell",
                }),
            ],
        }),
    );
    assert.deepEqual(await tableCellHost.locate(tableCellAnchor), {
        anchor: tableCellAnchor,
        text: DOCUMENT_ANCHOR.exact_quote,
        region: "table-cell",
    });

    let tableCellReplacement = "";
    const tableCellSelectionHost = new OfficeJsWordHost(
        officeRuntime(),
        wordRuntime({
            selection: fakeRange({
                text: DOCUMENT_ANCHOR.exact_quote,
                region: "TableCell",
                onInsertText: (text) => {
                    tableCellReplacement = text;
                },
            }),
        }),
    );
    assert.deepEqual(
        await tableCellSelectionHost.applyTrackedChange({
            anchor: {
                exact_quote: DOCUMENT_ANCHOR.exact_quote,
                locator: { scope: "selection" },
            },
            replacement: "balanced clause",
        }),
        { trackingRestored: true },
    );
    assert.equal(tableCellReplacement, "balanced clause");

    const regionMismatchHost = new OfficeJsWordHost(
        officeRuntime(),
        wordRuntime({
            matches: [
                fakeRange({
                    text: DOCUMENT_ANCHOR.exact_quote,
                    region: "TableCell",
                }),
            ],
        }),
    );
    await expectRejectsWith(
        () => regionMismatchHost.locate(DOCUMENT_ANCHOR),
        StaleWordAnchorError,
        "ANCHOR_STALE",
    );

    const headerHost = new OfficeJsWordHost(
        officeRuntime(),
        wordRuntime({
            selection: fakeRange({ text: "selected", region: "Header" }),
        }),
    );
    await expectRejectsWith(
        () =>
            headerHost.previewChange(
                {
                    exact_quote: "selected",
                    locator: { scope: "selection" },
                },
                "replacement",
            ),
        UnsupportedWordRegionError,
        "UNSUPPORTED_REGION",
    );

    const readOnlyHost = new OfficeJsWordHost(
        officeRuntime(),
        wordRuntime({
            matches: [
                fakeRange({
                    text: DOCUMENT_ANCHOR.exact_quote,
                    onInsertText: () => {
                        throw { code: "AccessDenied" };
                    },
                }),
            ],
        }),
    );
    await expectRejectsWith(
        () =>
            readOnlyHost.applyTrackedChange({
                anchor: DOCUMENT_ANCHOR,
                replacement: "replacement",
            }),
        ReadOnlyWordDocumentError,
        "DOCUMENT_READ_ONLY",
    );

    let insertedText = "";
    let insertedComment = "";
    const writableRange = fakeRange({
        text: DOCUMENT_ANCHOR.exact_quote,
        onInsertText: (text) => {
            insertedText = text;
        },
        onInsertComment: (text) => {
            insertedComment = text;
        },
    });
    const host = new OfficeJsWordHost(
        officeRuntime(),
        wordRuntime({
            matches: [writableRange],
            trackedChanges: [
                {
                    author: "Reviewer",
                    date: "2026-07-21T00:00:00.000Z",
                    text: "replacement",
                    type: "Added",
                },
            ],
        }),
    );
    assert.deepEqual(host.capabilities, {
        getSelection: true,
        getDocumentContext: true,
        locate: true,
        previewChange: true,
        applyTrackedChange: true,
        addComment: true,
        getTrackedChanges: true,
    });
    assert.deepEqual(await host.getSelection(), {
        text: "selected",
        region: "main-document",
        anchor: {
            exact_quote: "selected",
            locator: { scope: "selection", region: "main-document" },
        },
    });
    assert.deepEqual(await host.getDocumentContext(), {
        selection: {
            text: "selected",
            region: "main-document",
            anchor: {
                exact_quote: "selected",
                locator: { scope: "selection", region: "main-document" },
            },
        },
        documentText: "document text",
        documentTextTruncated: false,
        changeTrackingMode: "Off",
    });
    assert.deepEqual(await host.previewChange(DOCUMENT_ANCHOR, "replacement"), {
        anchor: DOCUMENT_ANCHOR,
        before: DOCUMENT_ANCHOR.exact_quote,
        after: "replacement",
    });
    assert.deepEqual(
        await host.applyTrackedChange({
            anchor: DOCUMENT_ANCHOR,
            replacement: "replacement",
        }),
        { trackingRestored: true },
    );
    await host.addComment({ anchor: DOCUMENT_ANCHOR, comment: "review note" });
    assert.equal(insertedText, "replacement");
    assert.equal(insertedComment, "review note");
    assert.deepEqual(await host.getTrackedChanges(), [
        {
            index: 0,
            author: "Reviewer",
            date: "2026-07-21T00:00:00.000Z",
            text: "replacement",
            type: "Added",
        },
    ]);

    const wordApi14Host = new OfficeJsWordHost(
        officeRuntime(1.4),
        wordRuntime({}),
    );
    assert.equal(wordApi14Host.capabilities.applyTrackedChange, true);
    assert.equal(wordApi14Host.capabilities.getTrackedChanges, false);

    const wordApi13Loads: string[] = [];
    const wordApi13Host = new OfficeJsWordHost(
        officeRuntime(1.3),
        wordRuntime({ documentLoads: wordApi13Loads }),
    );
    assert.equal(wordApi13Host.capabilities.getDocumentContext, true);
    assert.equal(
        (await wordApi13Host.getDocumentContext()).changeTrackingMode,
        null,
    );
    assert.equal(wordApi13Loads.includes("changeTrackingMode"), false);

    const repeatedQuote = "standard clause";
    function fakeParagraphSearch(paragraph: FakeRange) {
        return (text: string) => ({
            items: paragraph.text.includes(text)
                ? [{ ...paragraph, text }]
                : [],
            load: () => undefined,
        });
    }
    const paragraphOne = fakeRange({ text: `First ${repeatedQuote} first.` });
    const paragraphTwo = fakeRange({ text: `Second ${repeatedQuote} second.` });
    const paragraphHost = new OfficeJsWordHost(
        officeRuntime(),
        wordRuntime({
            matches: [
                fakeRange({ text: repeatedQuote }),
                fakeRange({ text: repeatedQuote }),
            ],
            paragraphs: [
                { ...paragraphOne, search: fakeParagraphSearch(paragraphOne) },
                { ...paragraphTwo, search: fakeParagraphSearch(paragraphTwo) },
            ],
        }),
    );
    assert.deepEqual(
        await paragraphHost.locate({
            exact_quote: repeatedQuote,
            locator: { scope: "document", paragraph_index: 1 },
        }),
        {
            anchor: {
                exact_quote: repeatedQuote,
                locator: { scope: "document", paragraph_index: 1 },
            },
            text: repeatedQuote,
            region: "main-document",
        },
    );

    const noHintAmbiguousHost = new OfficeJsWordHost(
        officeRuntime(),
        wordRuntime({
            matches: [
                fakeRange({ text: repeatedQuote }),
                fakeRange({ text: repeatedQuote }),
            ],
        }),
    );
    const noHintAmbiguous = await expectRejectsWith(
        () =>
            noHintAmbiguousHost.locate({
                exact_quote: repeatedQuote,
                locator: { scope: "document" },
            }),
        AmbiguousWordAnchorError,
        "ANCHOR_AMBIGUOUS",
    );
    assert.equal(noHintAmbiguous.matchCount, 2);

    const wordApi12RunCalls = { count: 0 };
    const wordApi12Host = new OfficeJsWordHost(
        officeRuntime(1.2),
        wordRuntime({ runCalls: wordApi12RunCalls }),
    );
    assert.equal(wordApi12Host.capabilities.getSelection, true);
    assert.deepEqual(await wordApi12Host.getSelection(), {
        text: "selected",
        region: "unknown",
        anchor: {
            exact_quote: "selected",
            locator: { scope: "selection", region: "unknown" },
        },
    });
    assert.equal(wordApi12RunCalls.count, 0);

    process.stdout.write("WordHost adapter tests passed.\n");
}

void run();
