export type WordHostKind = "loading" | "word" | "browser" | "unsupported";

export interface WordHostState {
    kind: WordHostKind;
    platform: string | null;
    canReadSelection: boolean;
    canReviewInDocument: boolean;
    message: string;
}

export interface WordHostCapabilities {
    getSelection: boolean;
    getDocumentContext: boolean;
    locate: boolean;
    previewChange: boolean;
    applyTrackedChange: boolean;
    addComment: boolean;
    getTrackedChanges: boolean;
}

/**
 * Structural subset of VeraStudioCitationAnchorWire. Keeping the wire field
 * names lets the document-studio anchor pass through without another model.
 */
export interface WordCitationAnchor {
    id?: string;
    exact_quote: string;
    locator?: Readonly<Record<string, unknown>>;
}

export type WordRegion =
    | "main-document"
    | "table-cell"
    | "section"
    | "header"
    | "footer"
    | "footnote"
    | "endnote"
    | "shape"
    | "unknown";

export interface WordSelection {
    text: string;
    region: WordRegion;
    anchor: WordCitationAnchor;
}

export interface WordDocumentContext {
    selection: WordSelection;
    documentText: string;
    documentTextTruncated: boolean;
    changeTrackingMode: string | null;
}

export interface LocatedWordAnchor {
    anchor: WordCitationAnchor;
    text: string;
    region: WordRegion;
}

export interface WordChangePreview {
    anchor: WordCitationAnchor;
    before: string;
    after: string;
}

export interface WordTrackedChange {
    index: number;
    author: string | null;
    date: string | null;
    text: string;
    type: string;
}

export interface WordHost {
    readonly capabilities: WordHostCapabilities;
    getSelection(): Promise<WordSelection>;
    getDocumentContext(): Promise<WordDocumentContext>;
    locate(
        anchor: WordCitationAnchor,
        options?: { select?: boolean },
    ): Promise<LocatedWordAnchor>;
    previewChange(
        anchor: WordCitationAnchor,
        replacement: string,
    ): Promise<WordChangePreview>;
    applyTrackedChange(args: {
        anchor: WordCitationAnchor;
        replacement: string;
    }): Promise<{ trackingRestored: boolean }>;
    addComment(args: {
        anchor: WordCitationAnchor;
        comment: string;
    }): Promise<void>;
    getTrackedChanges(): Promise<WordTrackedChange[]>;
}

export type WordHostErrorCode =
    | "ANCHOR_STALE"
    | "ANCHOR_AMBIGUOUS"
    | "DOCUMENT_READ_ONLY"
    | "UNSUPPORTED_REGION"
    | "CAPABILITY_UNAVAILABLE";

export class WordHostError extends Error {
    constructor(
        public readonly code: WordHostErrorCode,
        message: string,
        options?: { cause?: unknown },
    ) {
        super(message, options);
        this.name = "WordHostError";
    }
}

export class StaleWordAnchorError extends WordHostError {
    constructor(public readonly anchor: WordCitationAnchor) {
        super(
            "ANCHOR_STALE",
            "The Word anchor is stale. Reselect the original text, then try again.",
        );
        this.name = "StaleWordAnchorError";
    }
}

export class AmbiguousWordAnchorError extends WordHostError {
    constructor(
        public readonly anchor: WordCitationAnchor,
        public readonly matchCount: number,
    ) {
        super(
            "ANCHOR_AMBIGUOUS",
            `The Word anchor matched ${matchCount} locations. Select one exact location, then try again.`,
        );
        this.name = "AmbiguousWordAnchorError";
    }
}

export class ReadOnlyWordDocumentError extends WordHostError {
    constructor(options?: { cause?: unknown }) {
        super(
            "DOCUMENT_READ_ONLY",
            "This Word document is read-only. Vera did not change it.",
            options,
        );
        this.name = "ReadOnlyWordDocumentError";
    }
}

export class UnsupportedWordRegionError extends WordHostError {
    constructor(public readonly region: WordRegion | string) {
        super(
            "UNSUPPORTED_REGION",
            `Vera cannot change text in the Word ${region} region.`,
        );
        this.name = "UnsupportedWordRegionError";
    }
}

export class WordHostCapabilityError extends WordHostError {
    constructor(public readonly capability: keyof WordHostCapabilities) {
        super(
            "CAPABILITY_UNAVAILABLE",
            `The Word host does not support ${capability}.`,
        );
        this.name = "WordHostCapabilityError";
    }
}

interface OfficeAsyncResult {
    status: unknown;
    value?: unknown;
    error?: { message?: string };
}

interface OfficeDocumentRuntime {
    getSelectedDataAsync: (
        coercionType: unknown,
        callback: (result: OfficeAsyncResult) => void,
    ) => void;
}

export interface OfficeJsRuntime {
    onReady: () => Promise<{ host?: unknown; platform?: unknown } | null>;
    context?: {
        document?: OfficeDocumentRuntime;
        requirements?: {
            isSetSupported?: (name: string, version: string) => boolean;
        };
    };
    CoercionType?: { Text?: unknown };
    AsyncResultStatus?: { Succeeded?: unknown };
}

interface WordRangeRuntime {
    text?: string;
    parentBody?: WordBodyRuntime;
    load: (properties: string) => unknown;
    search?: (
        text: string,
        options?: Readonly<Record<string, boolean>>,
    ) => WordRangeCollectionRuntime;
    insertText?: (text: string, location: unknown) => unknown;
    insertComment?: (text: string) => unknown;
    select?: () => unknown;
}

interface WordParagraphRuntime {
    text?: string;
    load: (properties: string) => unknown;
    search?: (
        text: string,
        options?: Readonly<Record<string, boolean>>,
    ) => WordRangeCollectionRuntime;
}

interface WordParagraphCollectionRuntime {
    items?: WordParagraphRuntime[];
    load: (properties: string) => unknown;
}

interface WordBodyRuntime {
    type?: string;
    text?: string;
    paragraphs?: WordParagraphCollectionRuntime;
    load: (properties: string) => unknown;
    search?: (
        text: string,
        options?: Readonly<Record<string, boolean>>,
    ) => WordRangeCollectionRuntime;
    getTrackedChanges?: () => WordTrackedChangeCollectionRuntime;
}

interface WordRangeCollectionRuntime {
    items: WordRangeRuntime[];
    load: (properties: string) => unknown;
}

interface WordTrackedChangeRuntime {
    author?: string;
    date?: string | Date;
    text?: string;
    type?: string;
}

interface WordTrackedChangeCollectionRuntime {
    items: WordTrackedChangeRuntime[];
    load: (properties?: string) => unknown;
}

interface WordDocumentRuntime {
    body: WordBodyRuntime;
    changeTrackingMode?: string;
    load: (properties: string) => unknown;
    getSelection: () => WordRangeRuntime;
}

interface WordContextRuntime {
    document: WordDocumentRuntime;
    sync: () => Promise<void>;
}

export interface OfficeJsWordRuntime {
    run: <T>(
        callback: (context: WordContextRuntime) => Promise<T>,
    ) => Promise<T>;
    InsertLocation?: { replace?: unknown };
}

type OfficeWindow = Window & {
    Office?: OfficeJsRuntime;
    Word?: OfficeJsWordRuntime;
};

const HOST_TIMEOUT_MS = 2500;
const MAX_WORD_SEARCH_CHARS = 255;
const SUPPORTED_WRITE_REGIONS = new Set<WordRegion>([
    "main-document",
    "section",
    "table-cell",
]);

function officeWindow(): OfficeWindow | null {
    return typeof window === "undefined" ? null : (window as OfficeWindow);
}

function stringProperty(value: unknown, property: string): string | null {
    if (!value || typeof value !== "object") return null;
    const propertyValue = (value as Record<string, unknown>)[property];
    return typeof propertyValue === "string" ? propertyValue : null;
}

function officeErrorCode(error: unknown): string {
    const direct = stringProperty(error, "code");
    if (direct) return direct.toLowerCase();
    if (!error || typeof error !== "object") return "";
    return (
        stringProperty((error as Record<string, unknown>).debugInfo, "code") ??
        ""
    ).toLowerCase();
}

function classifyWriteError(error: unknown, fallback: string): Error {
    if (error instanceof WordHostError) return error;
    const code = officeErrorCode(error);
    if (
        code === "accessdenied" ||
        code === "permissiondenied" ||
        code === "readonly"
    ) {
        return new ReadOnlyWordDocumentError({ cause: error });
    }
    if (error instanceof Error && error.message.trim()) return error;
    return new Error(fallback, { cause: error });
}

function regionFromBodyType(value: unknown): WordRegion {
    switch (String(value ?? "").toLowerCase().replace(/[\s_-]/g, "")) {
        case "maindoc":
        case "maindocument":
            return "main-document";
        case "tablecell":
            return "table-cell";
        case "section":
            return "section";
        case "header":
            return "header";
        case "footer":
            return "footer";
        case "footnote":
        case "noteitem":
            return "footnote";
        case "endnote":
            return "endnote";
        case "shape":
            return "shape";
        default:
            return "unknown";
    }
}

function locatorString(
    anchor: WordCitationAnchor,
    key: string,
): string | null {
    const value = anchor.locator?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function locatorNumber(anchor: WordCitationAnchor, key: string): number | null {
    const value = anchor.locator?.[key];
    return typeof value === "number" && Number.isInteger(value) && value >= 0
        ? value
        : null;
}

function requestedRegion(anchor: WordCitationAnchor): WordRegion | string | null {
    const value = locatorString(anchor, "region");
    if (!value) return null;
    const region = regionFromBodyType(value);
    return region === "unknown" ? value : region;
}

function assertSupportedRegion(
    region: WordRegion | string,
): asserts region is WordRegion {
    if (!SUPPORTED_WRITE_REGIONS.has(region as WordRegion)) {
        throw new UnsupportedWordRegionError(region);
    }
}

async function loadRange(
    context: WordContextRuntime,
    range: WordRangeRuntime,
): Promise<{ text: string; region: WordRegion }> {
    range.load("text");
    range.parentBody?.load("type");
    await context.sync();
    return {
        text: range.text ?? "",
        region: regionFromBodyType(range.parentBody?.type),
    };
}

export function normalizeSelectionText(value: string): string {
    return value
        .replace(/\r\n?/g, "\n")
        .replace(/\u00a0/g, " ")
        .trim();
}

function isSameText(actual: string, expected: string): boolean {
    return normalizeSelectionText(actual) === normalizeSelectionText(expected);
}

export class OfficeJsWordHost implements WordHost {
    readonly capabilities: WordHostCapabilities;
    private readonly canReadSelectionRegion: boolean;
    private readonly canReadChangeTrackingMode: boolean;

    constructor(
        private readonly office: OfficeJsRuntime | undefined = officeWindow()?.Office,
        private readonly word: OfficeJsWordRuntime | undefined = officeWindow()?.Word,
    ) {
        const supports = (version: string) =>
            office?.context?.requirements?.isSetSupported?.(
                "WordApi",
                version,
            ) ?? false;
        const hasWordRun = typeof word?.run === "function";
        const hasCommonSelection =
            typeof office?.context?.document?.getSelectedDataAsync === "function";
        const supportsWordApi13 = supports("1.3");
        const supportsWordApi14 = supports("1.4");
        const supportsWordApi16 = supports("1.6");
        this.canReadSelectionRegion = hasWordRun && supportsWordApi13;
        this.canReadChangeTrackingMode = hasWordRun && supportsWordApi14;
        this.capabilities = Object.freeze({
            getSelection: this.canReadSelectionRegion || hasCommonSelection,
            getDocumentContext: hasWordRun && supportsWordApi13,
            locate: hasWordRun && supportsWordApi13,
            previewChange: hasWordRun && supportsWordApi13,
            applyTrackedChange: hasWordRun && supportsWordApi14,
            addComment: hasWordRun && supportsWordApi14,
            getTrackedChanges: hasWordRun && supportsWordApi16,
        });
    }

    async getSelection(): Promise<WordSelection> {
        if (this.canReadSelectionRegion) {
            return this.word!.run(async (context) => {
                const range = context.document.getSelection();
                const loaded = await loadRange(context, range);
                return {
                    text: loaded.text,
                    region: loaded.region,
                    anchor: {
                        exact_quote: loaded.text,
                        locator: {
                            scope: "selection",
                            region: loaded.region,
                        },
                    },
                };
            });
        }
        if (this.office?.context?.document?.getSelectedDataAsync) {
            const text = await readCurrentWordSelection(this.office);
            return {
                text,
                region: "unknown",
                anchor: {
                    exact_quote: text,
                    locator: { scope: "selection", region: "unknown" },
                },
            };
        }
        throw new WordHostCapabilityError("getSelection");
    }

    async getDocumentContext(): Promise<WordDocumentContext> {
        this.requireCapability("getDocumentContext");
        return this.word!.run(async (context) => {
            const documentRuntime = context.document;
            const range = documentRuntime.getSelection();
            if (this.canReadChangeTrackingMode) {
                documentRuntime.load("changeTrackingMode");
            }
            documentRuntime.body.load("text");
            const loaded = await loadRange(context, range);
            const documentText = documentRuntime.body.text ?? "";
            return {
                selection: {
                    text: loaded.text,
                    region: loaded.region,
                    anchor: {
                        exact_quote: loaded.text,
                        locator: {
                            scope: "selection",
                            region: loaded.region,
                        },
                    },
                },
                // Long-document review is segmented in the task pane. Keep the
                // complete body available so clauses after the former 20k cap
                // can be reviewed and positioned in their own paragraph.
                documentText,
                documentTextTruncated: false,
                changeTrackingMode: this.canReadChangeTrackingMode
                    ? documentRuntime.changeTrackingMode ?? null
                    : null,
            };
        });
    }

    async locate(
        anchor: WordCitationAnchor,
        options?: { select?: boolean },
    ): Promise<LocatedWordAnchor> {
        this.requireCapability("locate");
        return this.word!.run(async (context) => {
            const located = await this.locateRange(context, anchor);
            if (options?.select) {
                if (typeof located.range.select !== "function") {
                    throw new WordHostCapabilityError("locate");
                }
                // Keep selection as an explicit, user-triggered operation. The
                // same paragraph-plus-exact-quote lookup continues to reject
                // stale or ambiguous anchors before Word changes its selection.
                located.range.select();
                await context.sync();
            }
            return {
                anchor,
                text: located.text,
                region: located.region,
            };
        });
    }

    async previewChange(
        anchor: WordCitationAnchor,
        replacement: string,
    ): Promise<WordChangePreview> {
        this.requireCapability("previewChange");
        const located = await this.locate(anchor);
        return { anchor, before: located.text, after: replacement };
    }

    async applyTrackedChange(args: {
        anchor: WordCitationAnchor;
        replacement: string;
    }): Promise<{ trackingRestored: boolean }> {
        this.requireCapability("applyTrackedChange");
        try {
            return await this.word!.run(async (context) => {
                const documentRuntime = context.document;
                const located = await this.locateRange(context, args.anchor);
                documentRuntime.load("changeTrackingMode");
                await context.sync();

                if (typeof located.range.insertText !== "function") {
                    throw new WordHostCapabilityError("applyTrackedChange");
                }

                const previousMode = documentRuntime.changeTrackingMode ?? "Off";
                const mustEnableTracking = previousMode.toLowerCase() === "off";
                let appliedError: unknown = null;
                let restoreError: unknown = null;

                try {
                    if (mustEnableTracking) {
                        documentRuntime.changeTrackingMode = "TrackAll";
                        await context.sync();
                    }
                    located.range.insertText(
                        args.replacement,
                        this.word!.InsertLocation?.replace ?? "Replace",
                    );
                    await context.sync();
                } catch (error) {
                    appliedError = error;
                } finally {
                    if (mustEnableTracking) {
                        try {
                            documentRuntime.changeTrackingMode = previousMode;
                            await context.sync();
                        } catch (error) {
                            restoreError = error;
                        }
                    }
                }

                if (appliedError) throw appliedError;
                return { trackingRestored: !restoreError };
            });
        } catch (error) {
            throw classifyWriteError(
                error,
                "Word could not apply the tracked replacement.",
            );
        }
    }

    async addComment(args: {
        anchor: WordCitationAnchor;
        comment: string;
    }): Promise<void> {
        this.requireCapability("addComment");
        try {
            await this.word!.run(async (context) => {
                const located = await this.locateRange(context, args.anchor);
                if (typeof located.range.insertComment !== "function") {
                    throw new WordHostCapabilityError("addComment");
                }
                located.range.insertComment(args.comment);
                await context.sync();
            });
        } catch (error) {
            throw classifyWriteError(
                error,
                "Word could not add the suggestion comment.",
            );
        }
    }

    async getTrackedChanges(): Promise<WordTrackedChange[]> {
        this.requireCapability("getTrackedChanges");
        return this.word!.run(async (context) => {
            const collection = context.document.body.getTrackedChanges?.();
            if (!collection) {
                throw new WordHostCapabilityError("getTrackedChanges");
            }
            // Loading the collection is the documented WordApi 1.6 pattern and
            // hydrates its tracked-change items in the same request context.
            collection.load();
            await context.sync();
            return collection.items.map((change, index) => ({
                index,
                author: change.author ?? null,
                date:
                    change.date instanceof Date
                        ? change.date.toISOString()
                        : change.date ?? null,
                text: change.text ?? "",
                type: change.type ?? "None",
            }));
        });
    }

    private requireCapability(capability: keyof WordHostCapabilities): void {
        if (!this.capabilities[capability]) {
            throw new WordHostCapabilityError(capability);
        }
    }

    private async locateRange(
        context: WordContextRuntime,
        anchor: WordCitationAnchor,
    ): Promise<{ range: WordRangeRuntime; text: string; region: WordRegion }> {
        const regionHint = requestedRegion(anchor);
        if (regionHint) assertSupportedRegion(regionHint);

        const scope = locatorString(anchor, "scope") ?? "document";
        if (scope === "selection") {
            const range = context.document.getSelection();
            const loaded = await loadRange(context, range);
            if (!isSameText(loaded.text, anchor.exact_quote)) {
                throw new StaleWordAnchorError(anchor);
            }
            if (regionHint && loaded.region !== regionHint) {
                throw new StaleWordAnchorError(anchor);
            }
            assertSupportedRegion(loaded.region);
            return { range, ...loaded };
        }

        if (scope !== "document") {
            throw new UnsupportedWordRegionError(scope);
        }
        if (anchor.exact_quote.length > MAX_WORD_SEARCH_CHARS) {
            throw new WordHostCapabilityError("locate");
        }

        const paragraphIndex = locatorNumber(anchor, "paragraph_index");
        let paragraph: WordParagraphRuntime | null = null;
        if (paragraphIndex !== null) {
            const paragraphs = context.document.body.paragraphs;
            if (!paragraphs || typeof paragraphs.load !== "function") {
                throw new WordHostCapabilityError("locate");
            }
            // Word.ParagraphCollection has no getItemAt API. Load the real
            // collection first, then address its documented `items` array.
            // Loading text here also lets us reject paragraph drift before a
            // search or write is attempted.
            paragraphs.load("text");
            await context.sync();
            paragraph = paragraphs.items?.[paragraphIndex] ?? null;
            if (!paragraph) throw new StaleWordAnchorError(anchor);
        }
        const expectedParagraph = locatorString(anchor, "paragraph_text");
        if (paragraph && expectedParagraph) {
            if (!isSameText(paragraph.text ?? "", expectedParagraph)) {
                throw new StaleWordAnchorError(anchor);
            }
        }
        const searchOwner = paragraph ?? context.document.body;
        if (!searchOwner) {
            throw new WordHostCapabilityError("locate");
        }
        const collection = searchOwner.search?.(anchor.exact_quote, {
            ignorePunct: false,
            ignoreSpace: false,
            matchCase: true,
            matchPrefix: false,
            matchSuffix: false,
            matchWholeWord: false,
            matchWildcards: false,
        });
        if (!collection) throw new WordHostCapabilityError("locate");
        collection.load("items");
        await context.sync();
        if (collection.items.length === 0) {
            throw new StaleWordAnchorError(anchor);
        }
        if (collection.items.length > 1) {
            throw new AmbiguousWordAnchorError(anchor, collection.items.length);
        }
        const range = collection.items[0];
        const loaded = await loadRange(context, range);
        if (!isSameText(loaded.text, anchor.exact_quote)) {
            throw new StaleWordAnchorError(anchor);
        }
        if (regionHint && loaded.region !== regionHint) {
            throw new StaleWordAnchorError(anchor);
        }
        assertSupportedRegion(loaded.region);
        return { range, ...loaded };
    }
}

export async function detectWordHost(
    runtime = officeWindow()?.Office,
    timeoutMs = HOST_TIMEOUT_MS,
): Promise<WordHostState> {
    if (!runtime?.onReady) {
        return {
            kind: "browser",
            platform: null,
            canReadSelection: false,
            canReviewInDocument: false,
            message: "Open this page from the Vera add-in in Word.",
        };
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => resolve(null), timeoutMs);
    });

    let info: { host?: unknown; platform?: unknown } | null;
    try {
        // Office.js methods are host objects rather than ordinary detached
        // functions. Word for Mac requires the Office runtime as the receiver;
        // calling a destructured/bare method can resolve without host info and
        // incorrectly downgrade the real task pane to browser-preview mode.
        info = await Promise.race([runtime.onReady.call(runtime), timeout]);
    } catch {
        info = null;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }

    if (!info) {
        return {
            kind: "browser",
            platform: null,
            canReadSelection: false,
            canReviewInDocument: false,
            message: "Browser preview only. Word actions are unavailable.",
        };
    }

    const host = String(info.host ?? "").toLowerCase();
    const platform = info.platform ? String(info.platform) : null;
    if (host !== "word") {
        return {
            kind: "unsupported",
            platform,
            canReadSelection: false,
            canReviewInDocument: false,
            message: "This add-in is available in Microsoft Word.",
        };
    }

    const canReadSelection =
        typeof runtime.context?.document?.getSelectedDataAsync === "function";
    const canReviewInDocument =
        runtime.context?.requirements?.isSetSupported?.("WordApi", "1.4") ??
        false;

    return {
        kind: "word",
        platform,
        canReadSelection,
        canReviewInDocument,
        message: canReviewInDocument
            ? "Connected to Word"
            : "This Word version can read selections, but cannot add comments or tracked replacements from Vera.",
    };
}

export async function readCurrentWordSelection(
    runtime = officeWindow()?.Office,
): Promise<string> {
    const documentRuntime = runtime?.context?.document;
    if (!documentRuntime?.getSelectedDataAsync) {
        throw new WordHostCapabilityError("getSelection");
    }

    return new Promise<string>((resolve, reject) => {
        documentRuntime.getSelectedDataAsync(
            runtime?.CoercionType?.Text ?? "text",
            (result) => {
                const succeeded =
                    result.status === runtime?.AsyncResultStatus?.Succeeded ||
                    String(result.status).toLowerCase() === "succeeded";
                if (!succeeded) {
                    reject(
                        new Error(
                            result.error?.message ||
                                "Vera could not read the current Word selection.",
                        ),
                    );
                    return;
                }
                resolve(typeof result.value === "string" ? result.value : "");
            },
        );
    });
}

export async function readCurrentWordDocumentContext(args?: {
    officeRuntime?: OfficeJsRuntime;
    wordRuntime?: OfficeJsWordRuntime;
}): Promise<WordDocumentContext> {
    const host = new OfficeJsWordHost(
        args?.officeRuntime ?? officeWindow()?.Office,
        args?.wordRuntime ?? officeWindow()?.Word,
    );
    return host.getDocumentContext();
}

export async function locateWordAnchor(args: {
    anchor: WordCitationAnchor;
    select?: boolean;
    officeRuntime?: OfficeJsRuntime;
    wordRuntime?: OfficeJsWordRuntime;
}): Promise<LocatedWordAnchor> {
    const host = new OfficeJsWordHost(
        args.officeRuntime ?? officeWindow()?.Office,
        args.wordRuntime ?? officeWindow()?.Word,
    );
    return host.locate(args.anchor, { select: args.select });
}

export async function applyTrackedReplacementAtAnchor(args: {
    anchor: WordCitationAnchor;
    replacement: string;
    officeRuntime?: OfficeJsRuntime;
    wordRuntime?: OfficeJsWordRuntime;
}): Promise<{ trackingRestored: boolean }> {
    const host = new OfficeJsWordHost(
        args.officeRuntime ?? officeWindow()?.Office,
        args.wordRuntime ?? officeWindow()?.Word,
    );
    return host.applyTrackedChange({
        anchor: args.anchor,
        replacement: args.replacement,
    });
}

export async function insertSuggestionCommentAtAnchor(args: {
    anchor: WordCitationAnchor;
    comment: string;
    officeRuntime?: OfficeJsRuntime;
    wordRuntime?: OfficeJsWordRuntime;
}): Promise<void> {
    const host = new OfficeJsWordHost(
        args.officeRuntime ?? officeWindow()?.Office,
        args.wordRuntime ?? officeWindow()?.Word,
    );
    return host.addComment({
        anchor: args.anchor,
        comment: args.comment,
    });
}

export async function applyTrackedReplacement(args: {
    expectedSelection: string;
    replacement: string;
    runtime?: OfficeJsWordRuntime;
}): Promise<{ trackingRestored: boolean }> {
    const host = new OfficeJsWordHost(officeWindow()?.Office, args.runtime);
    return host.applyTrackedChange({
        anchor: {
            exact_quote: args.expectedSelection,
            locator: { scope: "selection" },
        },
        replacement: args.replacement,
    });
}

export async function insertSuggestionComment(args: {
    expectedSelection: string;
    comment: string;
    runtime?: OfficeJsWordRuntime;
}): Promise<void> {
    const host = new OfficeJsWordHost(officeWindow()?.Office, args.runtime);
    return host.addComment({
        anchor: {
            exact_quote: args.expectedSelection,
            locator: { scope: "selection" },
        },
        comment: args.comment,
    });
}
