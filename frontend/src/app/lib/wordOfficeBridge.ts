export type WordHostKind = "loading" | "word" | "browser" | "unsupported";

export interface WordHostState {
    kind: WordHostKind;
    platform: string | null;
    canReadSelection: boolean;
    canReviewInDocument: boolean;
    message: string;
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

interface OfficeRuntime {
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
    load: (properties: string) => void;
    insertText: (text: string, location: unknown) => unknown;
    insertComment?: (text: string) => unknown;
}

interface WordDocumentRuntime {
    changeTrackingMode?: string;
    load: (properties: string) => void;
    getSelection: () => WordRangeRuntime;
}

interface WordContextRuntime {
    document: WordDocumentRuntime;
    sync: () => Promise<void>;
}

interface WordRuntime {
    run: <T>(
        callback: (context: WordContextRuntime) => Promise<T>,
    ) => Promise<T>;
    InsertLocation?: { replace?: unknown };
}

type OfficeWindow = Window & {
    Office?: OfficeRuntime;
    Word?: WordRuntime;
};

const HOST_TIMEOUT_MS = 2500;

function officeWindow(): OfficeWindow | null {
    return typeof window === "undefined" ? null : (window as OfficeWindow);
}

function asReadableError(error: unknown, fallback: string): Error {
    if (error instanceof Error && error.message.trim()) return error;
    return new Error(fallback);
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
        info = await Promise.race([runtime.onReady(), timeout]);
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
        throw new Error("Word selection access is unavailable.");
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

export function normalizeSelectionText(value: string): string {
    return value
        .replace(/\r\n?/g, "\n")
        .replace(/\u00a0/g, " ")
        .trim();
}

function assertSameSelection(actual: string, expected: string) {
    if (normalizeSelectionText(actual) === normalizeSelectionText(expected)) {
        return;
    }
    throw new Error(
        "The Word selection changed. Reselect the original text, then try again.",
    );
}

export async function applyTrackedReplacement(args: {
    expectedSelection: string;
    replacement: string;
    runtime?: WordRuntime;
}): Promise<{ trackingRestored: boolean }> {
    const runtime = args.runtime ?? officeWindow()?.Word;
    if (!runtime?.run) {
        throw new Error("Tracked replacements are unavailable in this Word host.");
    }

    return runtime.run(async (context) => {
        const documentRuntime = context.document;
        const range = documentRuntime.getSelection();
        documentRuntime.load("changeTrackingMode");
        range.load("text");
        await context.sync();

        assertSameSelection(range.text ?? "", args.expectedSelection);

        const previousMode = documentRuntime.changeTrackingMode ?? "Off";
        const mustEnableTracking = previousMode.toLowerCase() === "off";
        let appliedError: unknown = null;
        let restoreError: unknown = null;

        try {
            if (mustEnableTracking) {
                documentRuntime.changeTrackingMode = "TrackAll";
                await context.sync();
            }
            range.insertText(
                args.replacement,
                runtime.InsertLocation?.replace ?? "Replace",
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

        if (appliedError) {
            throw asReadableError(
                appliedError,
                "Word could not apply the tracked replacement.",
            );
        }

        return { trackingRestored: !restoreError };
    });
}

export async function insertSuggestionComment(args: {
    expectedSelection: string;
    comment: string;
    runtime?: WordRuntime;
}): Promise<void> {
    const runtime = args.runtime ?? officeWindow()?.Word;
    if (!runtime?.run) {
        throw new Error("Word comments are unavailable in this host.");
    }

    await runtime.run(async (context) => {
        const range = context.document.getSelection();
        range.load("text");
        await context.sync();
        assertSameSelection(range.text ?? "", args.expectedSelection);
        if (typeof range.insertComment !== "function") {
            throw new Error("This Word version cannot insert comments from Vera.");
        }
        range.insertComment(args.comment);
        await context.sync();
    });
}
