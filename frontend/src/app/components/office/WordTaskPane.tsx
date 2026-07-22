"use client";

import Script from "next/script";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
    AlertCircle,
    Check,
    ChevronLeft,
    ChevronRight,
    Copy,
    ExternalLink,
    FilePenLine,
    Loader2,
    LocateFixed,
    MessageSquarePlus,
    RefreshCw,
} from "lucide-react";
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
} from "react";
import { SiteLogo } from "@/app/components/site-logo";
import { MODELS } from "@/app/components/assistant/ModelToggle";
import { PillButton } from "@/app/components/ui/pill-button";
import type { Citation, Project } from "@/app/components/shared/types";
import {
    getChat,
    listProjects,
    MikeApiError,
    streamProjectChat,
} from "@/app/lib/mikeApi";
import { useSelectedModel } from "@/app/hooks/useSelectedModel";
import {
    applyTrackedReplacementAtAnchor,
    applyTrackedReplacement,
    detectWordHost,
    insertSuggestionCommentAtAnchor,
    insertSuggestionComment,
    locateWordAnchor,
    readCurrentWordDocumentContext,
    readCurrentWordSelection,
    type WordHostState,
} from "@/app/lib/wordOfficeBridge";
import {
    buildWordDocumentReviewPrompt,
    buildWordSuggestionPrompt,
    parseWordDocumentSuggestions,
    readWordSuggestionStream,
    segmentWordDocumentText,
    WordSuggestionStreamError,
    type WordReviewMode,
    type WordReviewScope,
    type WordSuggestionItem,
} from "@/app/lib/wordSuggestion";
import {
    clearWordReviewSessionPointer,
    loadWordReviewSessionPointer,
    persistWordReviewSessionPointer,
    restoredWordReviewMatchesSource,
    restoreWordReviewFromChat,
    type WordSuggestionStatus as SuggestionStatus,
} from "@/app/lib/wordReviewSession";

const INITIAL_HOST: WordHostState = {
    kind: "loading",
    platform: null,
    canReadSelection: false,
    canReviewInDocument: false,
    message: "Connecting to Word…",
};

const MODEL_QUEUE_RETRY_DELAYS_MS = [1_500, 3_000, 6_000] as const;

function waitForModelRetry(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new DOMException("Suggestion generation was cancelled.", "AbortError"));
            return;
        }
        const onAbort = () => {
            window.clearTimeout(timeout);
            reject(
                new DOMException(
                    "Suggestion generation was cancelled.",
                    "AbortError",
                ),
            );
        };
        const timeout = window.setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, delayMs);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

const PREVIEW_PROJECTS: Project[] = [
    {
        id: "preview-matter",
        user_id: "preview-user",
        name: "Project Cedar",
        cm_number: null,
        practice: "Commercial",
        shared_with: [],
        created_at: "2026-07-21T00:00:00.000Z",
        updated_at: "2026-07-21T00:00:00.000Z",
    },
    {
        id: "preview-matter-two",
        user_id: "preview-user",
        name: "Project Juniper — Long matter name for responsive review",
        cm_number: null,
        practice: "Disputes",
        shared_with: [],
        created_at: "2026-07-21T00:00:00.000Z",
        updated_at: "2026-07-21T00:00:00.000Z",
    },
];

const ENGLISH_PREVIEW = {
    selection:
        "The Supplier may change the Fees at any time by giving the Customer written notice.",
    instruction:
        "Require at least 30 days' notice and allow termination before the new fees take effect.",
    suggestion:
        "The Supplier may change the Fees on at least 30 days’ prior written notice. The Customer may terminate this Agreement without penalty before the revised Fees take effect.",
};

const CHINESE_PREVIEW = {
    selection:
        "供应商可在任何时间通过向客户发出书面通知调整服务费用，调整后的费用自通知发出之日起立即生效，客户不得因此解除本协议或要求退还任何已经支付的款项。",
    instruction:
        "将通知期改为不少于三十日，并明确客户可在新费用生效前无责解除；保持条款严谨、完整，避免不必要扩大供应商免责范围。",
    suggestion:
        "供应商拟调整服务费用的，应至少提前三十日向客户发出书面通知。客户可在调整后的费用生效前书面通知供应商无责解除本协议；客户选择继续履行本协议的，调整后的费用自通知载明的生效日起适用。",
};

const PREVIEW_DOCUMENT = `${ENGLISH_PREVIEW.selection}\n\nThe Customer must pay every invoice within 10 days, including any disputed amount.`;

const PREVIEW_DOCUMENT_SUGGESTIONS: WordSuggestionItem[] = [
    {
        id: "word-suggestion-1",
        original: ENGLISH_PREVIEW.selection,
        replacement: ENGLISH_PREVIEW.suggestion,
        reason: "Adds a defined notice period and a termination right before the revised fees take effect.",
    },
    {
        id: "word-suggestion-2",
        original: "The Customer must pay every invoice within 10 days, including any disputed amount.",
        replacement: "The Customer must pay each undisputed invoice within 30 days after receipt.",
        reason: "Adds a dispute carve-out and a commercially workable payment period.",
    },
];

type ReviewSuggestion = WordSuggestionItem & {
    status: SuggestionStatus;
};

type SuggestionState = {
    items: ReviewSuggestion[];
    instruction: string;
    citations: Citation[];
    chatId: string | null;
    scope: WordReviewScope;
};

type AppliedState =
    | { kind: "tracked"; message: string }
    | { kind: "comment"; message: string }
    | { kind: "located"; message: string }
    | { kind: "skipped"; message: string }
    | null;

type RestoreIssue =
    | { kind: "retry"; message: string }
    | { kind: "unavailable"; message: string };

type TaskPaneTab = "assistant" | "review" | "actions";

const TASK_PANE_TABS: ReadonlyArray<readonly [TaskPaneTab, string]> = [
    ["assistant", "Assistant"],
    ["review", "Review"],
    ["actions", "Actions"],
];

const ACTION_SHORTCUTS: ReadonlyArray<{
    label: string;
    mode: WordReviewMode;
    instruction: string;
}> = [
    {
        label: "Review risk",
        mode: "review",
        instruction: "Identify the legal or commercial risk in the supplied text and propose a precise improvement.",
    },
    {
        label: "Improve clarity",
        mode: "review",
        instruction: "Improve clarity and concision while preserving the legal effect of the supplied text.",
    },
    {
        label: "Tighten drafting",
        mode: "rewrite",
        instruction: "Rewrite the supplied text to be more precise, complete, and internally consistent.",
    },
    {
        label: "Make balanced",
        mode: "rewrite",
        instruction: "Rewrite the supplied text to make obligations and remedies more balanced without changing the intended transaction.",
    },
];

function previewHost(): WordHostState {
    return {
        kind: "browser",
        platform: null,
        canReadSelection: false,
        canReviewInDocument: false,
        message: "Browser preview only. Word actions are unavailable.",
    };
}

function citationLabel(citation: Citation): string {
    if (citation.kind === "case") {
        return [citation.case_name, citation.citation]
            .filter(Boolean)
            .join(" · ");
    }
    const firstQuote = citation.quotes?.[0];
    const location = firstQuote?.cell
        ? [firstQuote.sheet, firstQuote.cell].filter(Boolean).join("!")
        : citation.page
          ? `page ${citation.page}`
          : null;
    return [citation.filename, location].filter(Boolean).join(" · ");
}

function readableError(error: unknown): string {
    if (error instanceof Error && error.message.trim()) return error.message;
    return "Vera could not complete that action. Please try again.";
}

function isProviderQueuedError(message: string): boolean {
    return /\b503\b|\b429\b|queued|queue|overloaded|temporarily unavailable|resource exhausted|timed out/i.test(
        message,
    );
}

function isStaleOrAmbiguousSelectionError(message: string): boolean {
    return /selection changed|reselect|ambiguous|exact match|exact location|matched \d+ locations|document changed|not unique/i.test(message);
}

function isReadOnlyDocumentError(message: string): boolean {
    return /read.?only|protected|permission|not available in this host/i.test(message);
}

function savedReviewUnavailableMessage(error: unknown): string {
    const detail = readableError(error);
    return detail
        ? `Saved review unavailable. ${detail}`
        : "Saved review unavailable. Start a new review to continue.";
}

function isTransientRestoreError(error: unknown): boolean {
    return (
        !(error instanceof MikeApiError) ||
        error.status === 429 ||
        error.status >= 500
    );
}

class SavedReviewRestoreError extends Error {
    constructor(error: unknown) {
        super(savedReviewUnavailableMessage(error));
        this.name = "SavedReviewRestoreError";
    }
}

function suggestionStatusLabel(status: SuggestionStatus): string {
    if (status === "applied") return "Applied in Word";
    if (status === "commented") return "Comment added";
    if (status === "skipped") return "Skipped";
    return "Pending review";
}

function suggestionStatusClass(status: SuggestionStatus): string {
    if (status === "applied") return "bg-emerald-100 text-emerald-900";
    if (status === "commented") return "bg-blue-100 text-blue-900";
    if (status === "skipped") return "bg-gray-200 text-gray-700";
    return "bg-amber-100 text-amber-900";
}

function decisionMessageClass(kind: NonNullable<AppliedState>["kind"]): string {
    return kind === "skipped"
        ? "bg-slate-100 text-slate-800"
        : "bg-emerald-50 text-emerald-900";
}

export function WordTaskPane() {
    const searchParams = useSearchParams();
    const previewMode = searchParams.get("preview");
    const isPreview = [
        "ready",
        "empty",
        "progress",
        "retrying",
        "restore-retry",
        "restore-unavailable",
    ].includes(previewMode ?? "");
    const previewContent = searchParams.get("lang") === "zh"
        ? CHINESE_PREVIEW
        : ENGLISH_PREVIEW;
    const [resumePointer] = useState(() =>
        !isPreview && typeof window !== "undefined"
            ? loadWordReviewSessionPointer(window.localStorage)
            : null,
    );
    const [model, setModel] = useSelectedModel();
    const [officeScriptReady, setOfficeScriptReady] = useState(false);
    const [host, setHost] = useState<WordHostState>(INITIAL_HOST);
    const [projects, setProjects] = useState<Project[]>([]);
    const [projectsLoading, setProjectsLoading] = useState(true);
    const [projectError, setProjectError] = useState<string | null>(null);
    const [selectedProjectId, setSelectedProjectId] = useState("");
    const [scope, setScope] = useState<WordReviewScope>(() =>
        resumePointer?.scope ??
        (searchParams.get("scope") === "document" ? "document" : "selection"),
    );
    const [selection, setSelection] = useState("");
    const [documentText, setDocumentText] = useState("");
    const [documentTextTruncated, setDocumentTextTruncated] = useState(false);
    const [selectionLoading, setSelectionLoading] = useState(false);
    const [sourceReady, setSourceReady] = useState(false);
    const [selectionError, setSelectionError] = useState<string | null>(null);
    const [mode, setMode] = useState<WordReviewMode>("review");
    const [instruction, setInstruction] = useState("");
    const [activeTab, setActiveTab] = useState<TaskPaneTab>("assistant");
    const [suggestion, setSuggestion] = useState<SuggestionState | null>(null);
    const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
    const [streamingText, setStreamingText] = useState("");
    const [reviewProgress, setReviewProgress] = useState<{
        current: number;
        total: number;
        retryAttempt: number;
    } | null>(null);
    const [generating, setGenerating] = useState(false);
    const [generateError, setGenerateError] = useState<string | null>(null);
    const [applying, setApplying] = useState<"tracked" | "comment" | "locate" | null>(null);
    const [applied, setApplied] = useState<AppliedState>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [resumeMessage, setResumeMessage] = useState<string | null>(null);
    const [resumeIssue, setResumeIssue] = useState<RestoreIssue | null>(null);
    const [resumeActive, setResumeActive] = useState(Boolean(resumePointer));
    const [restoreAttempt, setRestoreAttempt] = useState(0);
    const [restoringReview, setRestoringReview] = useState(false);
    const [restoredSourceMismatch, setRestoredSourceMismatch] = useState(false);
    const [copied, setCopied] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    const instructionRef = useRef<HTMLTextAreaElement>(null);
    const restoreStartedRef = useRef(false);

    const selectedProject = useMemo(
        () => projects.find((project) => project.id === selectedProjectId) ?? null,
        [projects, selectedProjectId],
    );

    const activeSuggestion = suggestion?.items[activeSuggestionIndex] ?? null;
    const sourceText = scope === "selection" ? selection : documentText;
    const sourcePreview =
        scope === "document" && sourceText.length > 1_200
            ? `${sourceText.slice(0, 1_200)}…`
            : sourceText;

    const loadSelection = useCallback(async () => {
        if (host.kind !== "word" || !host.canReadSelection) return;
        setSourceReady(false);
        setSelectionLoading(true);
        setSelectionError(null);
        setActionError(null);
        setResumeMessage(null);
        setSelection("");
        try {
            const value = await readCurrentWordSelection();
            setSelection(value.trim());
            setSuggestion(null);
            setActiveSuggestionIndex(0);
            setApplied(null);
            if (!value.trim()) {
                setSelectionError("Select the text you want Vera to review in Word.");
            }
        } catch (error) {
            setSelectionError(readableError(error));
        } finally {
            setSelectionLoading(false);
            setSourceReady(true);
        }
    }, [host.canReadSelection, host.kind]);

    const loadDocument = useCallback(async () => {
        if (host.kind !== "word" || !host.canReadSelection) return;
        setSourceReady(false);
        setSelectionLoading(true);
        setSelectionError(null);
        setActionError(null);
        setResumeMessage(null);
        setDocumentText("");
        setDocumentTextTruncated(false);
        try {
            const context = await readCurrentWordDocumentContext();
            // Preserve Word's leading/trailing paragraph separators. Removing
            // them would shift paragraph_index anchors away from the live host.
            setDocumentText(context.documentText);
            setDocumentTextTruncated(context.documentTextTruncated);
            setSuggestion(null);
            setActiveSuggestionIndex(0);
            setApplied(null);
            if (!context.documentText.trim()) {
                setSelectionError("This Word document does not contain text Vera can review.");
            }
        } catch (error) {
            setSelectionError(readableError(error));
        } finally {
            setSelectionLoading(false);
            setSourceReady(true);
        }
    }, [host.canReadSelection, host.kind]);

    useEffect(() => {
        if (typeof window !== "undefined" && "Office" in window) {
            setOfficeScriptReady(true);
        }
    }, []);

    useEffect(() => {
        if (isPreview) {
            setHost(previewHost());
            return;
        }
        if (!officeScriptReady) return;
        let cancelled = false;
        void detectWordHost().then((nextHost) => {
            if (!cancelled) setHost(nextHost);
        });
        return () => {
            cancelled = true;
        };
    }, [isPreview, officeScriptReady]);

    useEffect(() => {
        if (host.kind === "word" && host.canReadSelection) {
            if (scope === "document") void loadDocument();
            else void loadSelection();
        }
    }, [host.kind, host.canReadSelection, loadDocument, loadSelection, scope]);

    useEffect(() => {
        if (!isPreview) return;
        setProjects(PREVIEW_PROJECTS);
        setSelectedProjectId(PREVIEW_PROJECTS[0].id);
        setSelection(previewContent.selection);
        setDocumentText(
            searchParams.get("lang") === "zh"
                ? `${previewContent.selection}\n\n客户应在收到无争议发票后三十日内支付相应款项。`
                : PREVIEW_DOCUMENT,
        );
        setDocumentTextTruncated(false);
        setInstruction(previewContent.instruction);
        if (previewMode === "ready") {
            setSuggestion({
                items:
                    scope === "document" && searchParams.get("lang") !== "zh"
                        ? PREVIEW_DOCUMENT_SUGGESTIONS.map((item) => ({
                              ...item,
                              status: "pending" as const,
                          }))
                        : [
                              {
                                  id: "word-suggestion-1",
                                  original: previewContent.selection,
                                  replacement: previewContent.suggestion,
                                  reason: "Addresses the requested legal and drafting issue with a precise replacement.",
                                  status: "pending" as const,
                              },
                          ],
                instruction: previewContent.instruction,
                chatId: "preview-chat",
                citations: [
                    {
                        type: "citation_data",
                        kind: "document",
                        ref: 1,
                        doc_id: "contract-docx",
                        document_id: "preview-document",
                        filename: "Master Services Agreement.docx",
                        page: 4,
                        quote: previewContent.selection,
                    },
                ],
                scope,
            });
            setActiveSuggestionIndex(0);
            setActiveTab("review");
        } else if (previewMode === "progress" || previewMode === "retrying") {
            setScope("document");
            setGenerating(true);
            setReviewProgress({
                current: 2,
                total: 5,
                retryAttempt: previewMode === "retrying" ? 1 : 0,
            });
            setActiveTab("assistant");
        } else if (previewMode === "restore-retry") {
            setResumeIssue({
                kind: "retry",
                message:
                    "Vera could not restore the saved review. Failed to fetch.",
            });
            setActiveTab("assistant");
        } else if (previewMode === "restore-unavailable") {
            setResumeIssue({
                kind: "unavailable",
                message:
                    "Saved review unavailable. Start a new review to continue.",
            });
            setActiveTab("assistant");
        }
        setProjectsLoading(false);
    }, [isPreview, previewContent, previewMode, scope, searchParams]);

    useEffect(() => {
        if (isPreview) return;

        let cancelled = false;
        setProjectsLoading(true);
        setProjectError(null);
        void listProjects()
            .then((loaded) => {
                if (cancelled) return;
                setProjects(loaded);
                setSelectedProjectId((current) =>
                    loaded.some((project) => project.id === current)
                        ? current
                        : resumePointer && loaded.some((project) => project.id === resumePointer.projectId)
                          ? resumePointer.projectId
                          : (loaded[0]?.id ?? ""),
                );
                if (
                    resumePointer &&
                    !loaded.some(
                        (project) => project.id === resumePointer.projectId,
                    )
                ) {
                    if (typeof window !== "undefined") {
                        clearWordReviewSessionPointer(window.localStorage);
                    }
                    setResumeActive(false);
                    setResumeMessage(null);
                    setResumeIssue({
                        kind: "unavailable",
                        message:
                            "Saved review unavailable. Its Matter is no longer available. Start a new review to continue.",
                    });
                }
            })
            .catch((error) => {
                if (!cancelled) setProjectError(readableError(error));
            })
            .finally(() => {
                if (!cancelled) setProjectsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [isPreview, resumePointer]);

    useEffect(() => {
        if (
            isPreview ||
            !resumePointer ||
            !resumeActive ||
            restoreStartedRef.current ||
            projectsLoading ||
            host.kind !== "word" ||
            !sourceReady ||
            selectedProjectId !== resumePointer.projectId ||
            scope !== resumePointer.scope
        ) {
            return;
        }

        restoreStartedRef.current = true;
        setRestoringReview(true);
        let cancelled = false;
        void getChat(resumePointer.chatId)
            .then(async (detail) => {
                let restored: ReturnType<typeof restoreWordReviewFromChat>;
                try {
                    restored = restoreWordReviewFromChat({
                        pointer: resumePointer,
                        detail,
                    });
                } catch (error) {
                    throw new SavedReviewRestoreError(error);
                }
                let sourceMatches = restoredWordReviewMatchesSource(
                    restored,
                    sourceText,
                );
                if (sourceMatches && restored.scope === "document") {
                    try {
                        const pendingItems = restored.items.filter(
                            (item) => item.status === "pending",
                        );
                        await Promise.all(
                            pendingItems.map((item) =>
                                locateWordAnchor({
                                    anchor: {
                                        exact_quote: item.original,
                                        locator: { scope: "document", ...item.locator },
                                    },
                                }),
                            ),
                        );
                    } catch {
                        sourceMatches = false;
                    }
                }
                if (cancelled) return;

                setMode(restored.mode);
                setInstruction(restored.instruction);
                setSuggestion({
                    items: restored.items,
                    instruction: restored.instruction,
                    citations: restored.citations,
                    chatId: restored.chatId,
                    scope: restored.scope,
                });
                setActiveSuggestionIndex(restored.activeIndex);
                setApplied(null);
                setActiveTab("review");
                setResumeMessage("Previous review restored from the saved Matter chat.");
                setResumeIssue(null);
                setRestoredSourceMismatch(!sourceMatches);
                setActionError(
                    sourceMatches
                        ? null
                        : restored.scope === "selection"
                          ? "The Word selection changed since this review was saved. Refresh the selection and generate a new suggestion before applying it."
                          : "The Word document changed since this review was saved. Refresh the document and generate a new review before applying it.",
                );
            })
            .catch((error) => {
                if (cancelled) return;
                if (error instanceof SavedReviewRestoreError) {
                    if (typeof window !== "undefined") {
                        clearWordReviewSessionPointer(window.localStorage);
                    }
                    setResumeActive(false);
                    setResumeIssue({
                        kind: "unavailable",
                        message: error.message,
                    });
                    return;
                }
                if (isTransientRestoreError(error)) {
                    restoreStartedRef.current = false;
                    setResumeIssue({
                        kind: "retry",
                        message: `Vera could not restore the saved review. ${readableError(error)}`,
                    });
                    return;
                }
                if (typeof window !== "undefined") {
                    clearWordReviewSessionPointer(window.localStorage);
                }
                setResumeActive(false);
                setResumeIssue({
                    kind: "unavailable",
                    message: savedReviewUnavailableMessage(error),
                });
            })
            .finally(() => {
                if (!cancelled) setRestoringReview(false);
            });

        return () => {
            cancelled = true;
        };
    }, [
        host.kind,
        isPreview,
        projectsLoading,
        resumePointer,
        resumeActive,
        restoreAttempt,
        scope,
        selectedProjectId,
        sourceReady,
        sourceText,
    ]);

    useEffect(() => {
        if (
            isPreview ||
            typeof window === "undefined" ||
            !suggestion?.chatId ||
            !selectedProjectId
        ) {
            return;
        }
        persistWordReviewSessionPointer(window.localStorage, {
            projectId: selectedProjectId,
            chatId: suggestion.chatId,
            scope: suggestion.scope,
            mode,
            activeIndex: activeSuggestionIndex,
            statuses: Object.fromEntries(
                suggestion.items.map((item) => [item.id, item.status]),
            ),
        });
    }, [
        activeSuggestionIndex,
        isPreview,
        mode,
        selectedProjectId,
        suggestion,
    ]);

    useEffect(
        () => () => {
            abortRef.current?.abort();
        },
        [],
    );

    async function generateSuggestion() {
        if (!selectedProjectId || !sourceText.trim() || !instruction.trim()) return;
        setGenerating(true);
        setGenerateError(null);
        setActionError(null);
        setResumeMessage(null);
        setResumeIssue(null);
        setResumeActive(false);
        setRestoringReview(false);
        setRestoredSourceMismatch(false);
        setApplied(null);
        setStreamingText("");
        setSuggestion(null);
        setActiveSuggestionIndex(0);
        if (!isPreview && typeof window !== "undefined") {
            clearWordReviewSessionPointer(window.localStorage);
        }

        if (isPreview) {
            await new Promise((resolve) => window.setTimeout(resolve, 300));
            setSuggestion({
                items:
                    scope === "document"
                        ? PREVIEW_DOCUMENT_SUGGESTIONS.map((item) => ({
                              ...item,
                              status: "pending" as const,
                          }))
                        : [
                              {
                                  id: "word-suggestion-1",
                                  original: selection,
                                  replacement: previewContent.suggestion,
                                  reason: "Addresses the requested legal and drafting issue with a precise replacement.",
                                  status: "pending" as const,
                              },
                          ],
                instruction: instruction.trim(),
                chatId: "preview-chat",
                citations: [],
                scope,
            });
            setActiveTab("review");
            setGenerating(false);
            return;
        }

        const controller = new AbortController();
        abortRef.current = controller;
        let completedItemCount = 0;
        try {
            const segments =
                scope === "document" ? segmentWordDocumentText(documentText) : null;
            const prompts = segments
                ? segments.map((segment) =>
                      buildWordDocumentReviewPrompt({
                          mode,
                          documentText: segment.text,
                          instruction,
                          documentTextTruncated,
                          paragraphStart: segment.paragraphStart,
                          segmentIndex: segment.index,
                          segmentCount: segments.length,
                      }),
                  )
                : [
                      buildWordSuggestionPrompt({
                          mode,
                          selection,
                          instruction,
                      }),
                  ];
            let chatId: string | null = null;
            let items: WordSuggestionItem[] = [];
            let citations: Citation[] = [];

            for (const [index, prompt] of prompts.entries()) {
                if (controller.signal.aborted) {
                    throw new DOMException("Suggestion generation was cancelled.", "AbortError");
                }
                setReviewProgress({
                    current: index + 1,
                    total: prompts.length,
                    retryAttempt: 0,
                });
                let result: Awaited<
                    ReturnType<typeof readWordSuggestionStream>
                >;
                for (
                    let attempt = 0;
                    ;
                    attempt += 1
                ) {
                    try {
                        const response = await streamProjectChat({
                            projectId: selectedProjectId,
                            messages: [{ role: "user", content: prompt }],
                            ...(chatId ? { chat_id: chatId } : {}),
                            model,
                            signal: controller.signal,
                        });
                        result = await readWordSuggestionStream(
                            response,
                            setStreamingText,
                        );
                        break;
                    } catch (error) {
                        if (
                            error instanceof WordSuggestionStreamError &&
                            error.chatId
                        ) {
                            chatId = error.chatId;
                        }
                        const message = readableError(error);
                        const retryDelay = MODEL_QUEUE_RETRY_DELAYS_MS[attempt];
                        if (
                            retryDelay === undefined ||
                            !isProviderQueuedError(message)
                        ) {
                            throw error;
                        }
                        setStreamingText("");
                        setReviewProgress({
                            current: index + 1,
                            total: prompts.length,
                            retryAttempt: attempt + 1,
                        });
                        await waitForModelRetry(retryDelay, controller.signal);
                    }
                }
                chatId = result.chatId ?? chatId;
                const nextItems = segments
                    ? parseWordDocumentSuggestions(result.text, segments[index].text, {
                          paragraphStart: segments[index].paragraphStart,
                          idOffset: items.length,
                      })
                    : [
                          {
                              id: "word-suggestion-1",
                              original: selection,
                              replacement: result.text,
                              reason: "Addresses the instruction for the selected Word text.",
                          },
                      ];
                if (scope === "document" && host.kind === "word") {
                    await Promise.all(
                        nextItems.map((item) =>
                            locateWordAnchor({
                                anchor: {
                                    exact_quote: item.original,
                                    locator: { scope: "document", ...item.locator },
                                },
                            }),
                        ),
                    );
                }
                if (controller.signal.aborted) {
                    throw new DOMException("Suggestion generation was cancelled.", "AbortError");
                }
                items = [...items, ...nextItems];
                completedItemCount = items.length;
                citations = [...citations, ...result.citations];
                if (items.length) {
                    // Completed sections remain usable if a later model request
                    // is cancelled. The existing session pointer restores them.
                    setSuggestion({
                        items: items.map((item) => ({ ...item, status: "pending" })),
                        instruction: instruction.trim(),
                        citations,
                        chatId,
                        scope,
                    });
                }
            }
            if (!items.length) {
                throw new Error("Vera did not identify any changes in this document.");
            }
            setActiveTab("review");
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                setGenerateError(
                    scope === "document" && completedItemCount
                        ? "Document review was cancelled. Suggestions from completed sections are ready to review."
                        : "Suggestion generation was cancelled.",
                );
            } else {
                const message = readableError(error);
                setGenerateError(
                    scope === "document" && isStaleOrAmbiguousSelectionError(message)
                        ? "The document changed or this passage is not unique. Refresh the document and generate the review again."
                        : isProviderQueuedError(message)
                        ? "Vera is waiting for the model. Your request could not be completed yet; try again shortly."
                        : message,
                );
            }
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
            setGenerating(false);
            setStreamingText("");
            setReviewProgress(null);
        }
    }

    function updateSuggestionStatus(status: SuggestionStatus) {
        if (!activeSuggestion) return;
        setSuggestion((current) =>
            current
                ? {
                      ...current,
                      items: current.items.map((item) =>
                          item.id === activeSuggestion.id ? { ...item, status } : item,
                      ),
                  }
                : current,
        );
    }

    function showSuggestion(index: number) {
        if (!suggestion || index < 0 || index >= suggestion.items.length) return;
        setActiveSuggestionIndex(index);
        setApplied(null);
        setActionError(null);
        setCopied(false);
    }

    function skipSuggestion() {
        if (!activeSuggestion || activeSuggestion.status !== "pending") return;
        updateSuggestionStatus("skipped");
        setApplied({
            kind: "skipped",
            message: "Skipped this suggestion. Vera did not change the document.",
        });
        setActionError(null);
    }

    function changeScope(nextScope: WordReviewScope) {
        if (generating || nextScope === scope) return;
        setScope(nextScope);
        setSuggestion(null);
        setActiveSuggestionIndex(0);
        setApplied(null);
        setSelectionError(null);
        setActionError(null);
        setResumeMessage(null);
        setResumeIssue(null);
        setRestoredSourceMismatch(false);
        setSourceReady(false);
    }

    function handleTabKeyDown(
        event: KeyboardEvent<HTMLButtonElement>,
        currentTab: TaskPaneTab,
    ) {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const currentIndex = TASK_PANE_TABS.findIndex(([value]) => value === currentTab);
        const nextIndex =
            event.key === "Home"
                ? 0
                : event.key === "End"
                  ? TASK_PANE_TABS.length - 1
                  : event.key === "ArrowRight"
                    ? (currentIndex + 1) % TASK_PANE_TABS.length
                    : (currentIndex - 1 + TASK_PANE_TABS.length) % TASK_PANE_TABS.length;
        const nextTab = TASK_PANE_TABS[nextIndex][0];
        setActiveTab(nextTab);
        window.setTimeout(() => document.getElementById(`word-tab-${nextTab}`)?.focus(), 0);
    }

    function cancelGeneration() {
        if (isPreview) {
            setGenerating(false);
            setReviewProgress(null);
            setStreamingText("");
            return;
        }
        abortRef.current?.abort();
    }

    function retryRestore() {
        if (restoringReview) return;
        if (isPreview && previewMode === "restore-retry") {
            setRestoringReview(true);
            window.setTimeout(() => {
                setRestoringReview(false);
                setResumeIssue({
                    kind: "retry",
                    message:
                        "Vera could not restore the saved review. Failed to fetch.",
                });
            }, 400);
            return;
        }
        if (!resumePointer || !resumeActive) return;
        setRestoringReview(true);
        restoreStartedRef.current = false;
        setRestoreAttempt((attempt) => attempt + 1);
    }

    function startNewReview() {
        if (!isPreview && typeof window !== "undefined") {
            clearWordReviewSessionPointer(window.localStorage);
        }
        setResumeActive(false);
        setResumeIssue(null);
        setRestoringReview(false);
        setResumeMessage(null);
        setRestoredSourceMismatch(false);
        setSuggestion(null);
        setActiveSuggestionIndex(0);
        setApplied(null);
        setActionError(null);
        setGenerateError(null);
        setActiveTab("assistant");
        window.setTimeout(() => instructionRef.current?.focus(), 0);
    }

    async function refreshStaleRestoredSource() {
        if (!isPreview && typeof window !== "undefined") {
            clearWordReviewSessionPointer(window.localStorage);
        }
        setResumeActive(false);
        setResumeIssue(null);
        setRestoringReview(false);
        setRestoredSourceMismatch(false);
        await (scope === "selection" ? loadSelection() : loadDocument());
        setActiveTab("assistant");
        window.setTimeout(() => instructionRef.current?.focus(), 0);
    }

    function applyActionShortcut(shortcut: (typeof ACTION_SHORTCUTS)[number]) {
        if (generating || restoringReview) return;
        setMode(shortcut.mode);
        setInstruction(shortcut.instruction);
        setApplied(null);
        setGenerateError(null);
        setActiveTab("assistant");
        window.setTimeout(() => instructionRef.current?.focus(), 0);
    }

    async function applySuggestionAsTrackedChange() {
        if (!suggestion || !activeSuggestion || applying) return;
        setApplying("tracked");
        setActionError(null);
        try {
            const result =
                suggestion.scope === "document"
                    ? await applyTrackedReplacementAtAnchor({
                          anchor: {
                              exact_quote: activeSuggestion.original,
                              locator: { scope: "document", ...activeSuggestion.locator },
                          },
                          replacement: activeSuggestion.replacement,
                      })
                    : await applyTrackedReplacement({
                          expectedSelection: activeSuggestion.original,
                          replacement: activeSuggestion.replacement,
                      });
            updateSuggestionStatus("applied");
            setApplied({
                kind: "tracked",
                message: result.trackingRestored
                    ? "Inserted as a tracked change. Review it in Word; Vera did not accept it."
                    : "Inserted as a tracked change. Word kept change tracking enabled; review the document setting before continuing.",
            });
        } catch (error) {
            const message = readableError(error);
            setActionError(
                suggestion.scope === "document" && isStaleOrAmbiguousSelectionError(message)
                    ? "The document changed or this passage is not unique. Refresh the document and generate the review again."
                    : message,
            );
        } finally {
            setApplying(null);
        }
    }

    async function addSuggestionComment() {
        if (!suggestion || !activeSuggestion || applying) return;
        setApplying("comment");
        setActionError(null);
        try {
            const comment = `Vera suggestion:\n${activeSuggestion.replacement}\n\nReason: ${activeSuggestion.reason}\n\nInstruction: ${suggestion.instruction}`;
            if (suggestion.scope === "document") {
                await insertSuggestionCommentAtAnchor({
                    anchor: {
                        exact_quote: activeSuggestion.original,
                        locator: { scope: "document", ...activeSuggestion.locator },
                    },
                    comment,
                });
            } else {
                await insertSuggestionComment({
                    expectedSelection: activeSuggestion.original,
                    comment,
                });
            }
            updateSuggestionStatus("commented");
            setApplied({
                kind: "comment",
                message: `Added a comment to the ${suggestion.scope === "document" ? "source passage" : "selected text"}. The document text was not changed.`,
            });
        } catch (error) {
            const message = readableError(error);
            setActionError(
                suggestion.scope === "document" && isStaleOrAmbiguousSelectionError(message)
                    ? "The document changed or this passage is not unique. Refresh the document and generate the review again."
                    : message,
            );
        } finally {
            setApplying(null);
        }
    }

    async function locateSuggestionInDocument() {
        if (!suggestion || !activeSuggestion || applying) return;
        setApplying("locate");
        setActionError(null);
        try {
            await locateWordAnchor({
                anchor: {
                    exact_quote: activeSuggestion.original,
                    locator:
                        suggestion.scope === "document"
                            ? { scope: "document", ...activeSuggestion.locator }
                            : { scope: "selection" },
                },
                select: true,
            });
            setApplied({
                kind: "located",
                message: "Located the original text in Word. Vera did not change the document.",
            });
        } catch (error) {
            const message = readableError(error);
            setActionError(
                suggestion.scope === "document" && isStaleOrAmbiguousSelectionError(message)
                    ? "The document changed or this passage is not unique. Refresh the document and generate the review again."
                    : message,
            );
        } finally {
            setApplying(null);
        }
    }

    async function copySuggestion() {
        if (!activeSuggestion) return;
        try {
            await navigator.clipboard.writeText(activeSuggestion.replacement);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1800);
        } catch {
            setActionError("Vera could not copy the suggestion. Select the text and copy it manually.");
        }
    }

    const canGenerate =
        !!selectedProjectId &&
        !!sourceText.trim() &&
        !!instruction.trim() &&
        !selectionLoading &&
        !selectionError &&
        !restoringReview &&
        !generating;
    const staleOrAmbiguousSelection =
        !!actionError && isStaleOrAmbiguousSelectionError(actionError);
    const readOnlyDocument = !!actionError && isReadOnlyDocumentError(actionError);
    const canWriteToWord =
        host.kind === "word" &&
        host.canReviewInDocument &&
        activeSuggestion?.status === "pending" &&
        !staleOrAmbiguousSelection &&
        !readOnlyDocument;
    const canLocateInWord =
        host.kind === "word" &&
        host.canReadSelection &&
        !staleOrAmbiguousSelection;
    const providerQueued =
        !!generateError &&
        (isProviderQueuedError(generateError) || /waiting for the model/i.test(generateError));
    const documentLocationError =
        scope === "document" &&
        !!generateError &&
        isStaleOrAmbiguousSelectionError(generateError);
    const generateErrorTitle = providerQueued
        ? "Model is queued"
        : documentLocationError
          ? "Document changed"
          : generateError && /model|provider|api|network|fetch|unavailable|quota|credential/i.test(generateError)
            ? "Model unavailable"
            : "Review could not be generated";
    const writeRestrictionMessage = staleOrAmbiguousSelection
        ? `The ${scope === "selection" ? "selection" : "document"} changed. Refresh it before applying this suggestion.`
        : readOnlyDocument
          ? "This Word document is read-only. You can still copy the suggestion."
          : host.kind === "word"
            ? "This Word version can read text but cannot insert a comment or tracked replacement. You can still copy the suggestion."
            : "Open this task pane in a compatible Word host to insert a comment or tracked replacement. You can still copy the suggestion.";

    return (
        <>
            <Script
                src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"
                strategy="afterInteractive"
                onReady={() => setOfficeScriptReady(true)}
                onError={() => {
                    if (!isPreview) setHost(previewHost());
                }}
            />
            <div
                lang={searchParams.get("lang") === "zh" ? "zh-CN" : "en"}
                className="min-h-dvh bg-gray-50/80 text-gray-900"
            >
                <div className="mx-auto flex min-h-dvh w-full max-w-[30rem] flex-col bg-white min-[480px]:border-x min-[480px]:border-gray-200/80">
                    <header className="flex min-h-14 items-center gap-3 border-b border-gray-200/80 px-3 min-[360px]:px-4">
                        <SiteLogo size="sm" className="text-gray-900" />
                        <div className="ml-auto flex min-w-0 items-center gap-2 text-xs font-medium text-gray-600">
                            {host.kind === "loading" ? (
                                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
                            ) : (
                                <span
                                    className={`h-2 w-2 shrink-0 rounded-full ${host.kind === "word" ? "bg-emerald-600" : "bg-amber-500"}`}
                                    aria-hidden="true"
                                />
                            )}
                            <span className="truncate">
                                {host.kind === "word"
                                    ? host.canReviewInDocument
                                      ? "Word connected"
                                      : "Limited Word support"
                                    : host.kind === "loading"
                                      ? "Connecting"
                                      : "Browser preview"}
                            </span>
                        </div>
                    </header>

                    {host.kind !== "word" && host.kind !== "loading" && (
                        <div
                            role="status"
                            className="flex gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2.5 text-sm leading-5 text-amber-900 min-[360px]:px-4"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{host.message}</span>
                        </div>
                    )}

                    <div
                        role="tablist"
                        aria-label="Word review"
                        className="mx-3 mt-3 grid grid-cols-3 rounded-lg bg-gray-100 p-1 min-[360px]:mx-4"
                    >
                        {TASK_PANE_TABS.map(([value, label]) => (
                            <button
                                key={value}
                                id={`word-tab-${value}`}
                                type="button"
                                role="tab"
                                aria-selected={activeTab === value}
                                aria-controls={`word-panel-${value}`}
                                tabIndex={activeTab === value ? 0 : -1}
                                onClick={() => setActiveTab(value)}
                                onKeyDown={(event) => handleTabKeyDown(event, value)}
                                className={`min-h-9 rounded-md px-1 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-600 ${activeTab === value ? "bg-white text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900"}`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    <main className="min-h-0 flex-1 overflow-y-auto px-3 py-5 min-[360px]:px-4">
                        {activeTab === "assistant" && (
                            <div id="word-panel-assistant" role="tabpanel" aria-labelledby="word-tab-assistant">
                                <section aria-labelledby="matter-heading">
                                    <h2 id="matter-heading" className="text-sm font-semibold text-gray-900">
                                        Matter
                                    </h2>
                                    <div className="mt-2">
                                        {projectsLoading ? (
                                            <div className="h-10 animate-pulse rounded-lg bg-gray-100 motion-reduce:animate-none" />
                                        ) : projects.length > 0 ? (
                                            <select
                                                aria-label="Matter"
                                                value={selectedProjectId}
                                                disabled={generating || restoringReview}
                                                onChange={(event) => {
                                                    setSelectedProjectId(event.target.value);
                                                    setSuggestion(null);
                                                    setApplied(null);
                                                    setActionError(null);
                                                    setResumeMessage(null);
                                                }}
                                                className="min-h-10 w-full truncate rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none transition-colors hover:border-gray-400 focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
                                            >
                                                {projects.map((project) => (
                                                    <option key={project.id} value={project.id}>
                                                        {project.name}
                                                    </option>
                                                ))}
                                            </select>
                                        ) : (
                                            <p className="text-sm leading-6 text-gray-700">
                                                No Matters are available. Create one in Vera before starting a review.
                                            </p>
                                        )}
                                    </div>
                                    {projectError && (
                                        <p role="alert" className="mt-2 text-sm leading-5 text-red-700">
                                            {projectError}
                                        </p>
                                    )}
                                </section>

                                <section aria-labelledby="scope-heading" className="mt-6 border-t border-gray-200/80 pt-6">
                                    <h2 id="scope-heading" className="text-sm font-semibold text-gray-900">
                                        Review scope
                                    </h2>
                                    <div role="group" aria-label="Word review scope" className="mt-2 flex rounded-lg bg-gray-100 p-1">
                                        {(["selection", "document"] as const).map((value) => (
                                            <button
                                                key={value}
                                                type="button"
                                                disabled={generating || restoringReview}
                                                aria-pressed={scope === value}
                                                onClick={() => changeScope(value)}
                                                className={`min-h-9 flex-1 whitespace-nowrap rounded-md px-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-not-allowed disabled:opacity-50 min-[300px]:px-3 min-[300px]:text-sm ${scope === value ? "bg-white text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900"}`}
                                            >
                                                {value === "selection" ? "Selected text" : "Main document"}
                                            </button>
                                        ))}
                                    </div>
                                </section>

                                <section aria-labelledby="selection-heading" className="mt-4">
                                    <div className="flex items-center gap-2">
                                        <h2 id="selection-heading" className="text-sm font-semibold text-gray-900">
                                            {scope === "selection" ? "Word selection" : "Main document text"}
                                        </h2>
                                        <button
                                            type="button"
                                            onClick={() => void (scope === "selection" ? loadSelection() : loadDocument())}
                                            disabled={host.kind !== "word" || selectionLoading || generating || restoringReview}
                                            className="ml-auto inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-gray-600 outline-none transition-colors hover:bg-gray-100 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-not-allowed disabled:opacity-45"
                                        >
                                            <RefreshCw className={`h-3.5 w-3.5 ${selectionLoading ? "animate-spin motion-reduce:animate-none" : ""}`} />
                                            Refresh
                                        </button>
                                    </div>
                                    <div
                                        role="region"
                                        aria-label={scope === "selection" ? "Selected Word text" : "Loaded main document text"}
                                        tabIndex={0}
                                        className="mt-2 max-h-36 overflow-y-auto rounded-lg bg-gray-100 px-3 py-3 text-base leading-relaxed text-gray-900 outline-none [line-break:strict] [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-blue-600"
                                    >
                                        {sourcePreview || (scope === "selection" ? "Select text in Word, then refresh the selection." : "Refresh to load the current Word document.")}
                                    </div>
                                    {scope === "document" && documentText && (
                                        <p className="mt-2 text-xs leading-5 text-gray-600">
                                            {documentText.length.toLocaleString()} characters loaded{documentTextTruncated ? "; review is limited to this first section" : "; review runs in paragraph sections"}.
                                        </p>
                                    )}
                                    {selectionError && (
                                        <p role="alert" className="mt-2 text-sm leading-5 text-red-700">
                                            {selectionError}
                                        </p>
                                    )}
                                </section>

                                <section aria-labelledby="instruction-heading" className="mt-6 border-t border-gray-200/80 pt-6">
                                    <h2 id="instruction-heading" className="text-sm font-semibold text-gray-900">
                                        Instruction
                                    </h2>
                                    <div role="group" aria-label="Suggestion type" className="mt-2 flex rounded-lg bg-gray-100 p-1">
                                        {(["review", "rewrite"] as const).map((value) => (
                                            <button
                                                key={value}
                                                type="button"
                                                disabled={generating || restoringReview}
                                                aria-pressed={mode === value}
                                                onClick={() => setMode(value)}
                                                className={`min-h-9 flex-1 rounded-md px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-not-allowed disabled:opacity-50 ${mode === value ? "bg-white text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900"}`}
                                            >
                                                {value === "review" ? "Review" : "Rewrite"}
                                            </button>
                                        ))}
                                    </div>
                                    <div className="mt-2 flex min-h-10 items-center gap-3 rounded-lg border border-gray-200 bg-white px-3">
                                        <label
                                            htmlFor="word-review-model"
                                            className="shrink-0 text-xs font-medium text-gray-600"
                                        >
                                            Model
                                        </label>
                                        <select
                                            id="word-review-model"
                                            value={model}
                                            disabled={generating || restoringReview}
                                            onChange={(event) => {
                                                setModel(event.target.value);
                                                setGenerateError(null);
                                            }}
                                            className="min-w-0 flex-1 truncate rounded-md bg-transparent py-2 text-right text-sm font-medium text-gray-800 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            {MODELS.map((option) => (
                                                <option key={option.id} value={option.id}>
                                                    {option.label}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    <label htmlFor="word-review-instruction" className="sr-only">
                                        Review or rewrite instruction
                                    </label>
                                    <textarea
                                        ref={instructionRef}
                                        id="word-review-instruction"
                                        value={instruction}
                                        disabled={generating || restoringReview}
                                        onChange={(event) => {
                                            setInstruction(event.target.value);
                                            setApplied(null);
                                        }}
                                        onKeyDown={(event) => {
                                            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                                                event.preventDefault();
                                                void generateSuggestion();
                                            }
                                        }}
                                        rows={4}
                                        placeholder={mode === "review" ? "Describe the risk to address or the outcome you need." : "Describe how the selected text should be rewritten."}
                                        className="mt-2 w-full resize-y rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base leading-relaxed text-gray-900 outline-none placeholder:text-gray-600 hover:border-gray-400 focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-600"
                                    />
                                    <div className="mt-3 flex flex-wrap gap-2">
                                        <PillButton tone="black" size="normal" className="min-h-11 flex-1" disabled={!canGenerate} onClick={() => void generateSuggestion()}>
                                            {generating && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
                                            {generating
                                                ? scope === "document"
                                                    ? reviewProgress
                                                        ? reviewProgress.retryAttempt > 0
                                                            ? `Retrying section ${reviewProgress.current} of ${reviewProgress.total}`
                                                            : `Reviewing section ${reviewProgress.current} of ${reviewProgress.total}`
                                                        : "Reviewing document"
                                                    : "Generating suggestion"
                                                : scope === "document"
                                                  ? "Generate review"
                                                  : "Generate suggestion"}
                                        </PillButton>
                                        {generating && (
                                            <PillButton tone="white" size="normal" className="min-h-11 flex-1" onClick={cancelGeneration}>
                                                Cancel
                                            </PillButton>
                                        )}
                                    </div>
                                    {generating && scope === "document" && reviewProgress && (
                                        <p
                                            role="status"
                                            aria-live="polite"
                                            className="mt-2 text-sm leading-5 text-gray-600"
                                        >
                                            {reviewProgress.retryAttempt > 0
                                                ? `The model is busy. Retrying section ${reviewProgress.current} of ${reviewProgress.total}.`
                                                : `Reviewing section ${reviewProgress.current} of ${reviewProgress.total}.`}
                                        </p>
                                    )}
                                    <p className="mt-2 text-sm leading-5 text-gray-600">
                                        {scope === "selection" ? "Selected text" : "Loaded main document text"} is sent to your configured model when you generate suggestions.
                                    </p>
                                    {restoringReview && (
                                        <p
                                            role="status"
                                            aria-live="polite"
                                            className="mt-2 text-sm leading-5 text-gray-600"
                                        >
                                            Restoring saved review…
                                        </p>
                                    )}
                                    {resumeIssue && (
                                        <div
                                            role="alert"
                                            className={`mt-2 rounded-lg px-3 py-2.5 text-sm leading-5 ${resumeIssue.kind === "retry" ? "bg-amber-50 text-amber-900" : "bg-red-50 text-red-800"}`}
                                        >
                                            <p className="font-medium">
                                                {resumeIssue.kind === "retry"
                                                    ? "Saved review could not be restored"
                                                    : "Saved review unavailable"}
                                            </p>
                                            <p className="mt-1">{resumeIssue.message}</p>
                                            {resumeIssue.kind === "retry" ? (
                                                <button
                                                    type="button"
                                                    aria-disabled={restoringReview}
                                                    onClick={retryRestore}
                                                    className="mt-2 min-h-11 rounded-lg px-2 text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 aria-disabled:cursor-wait aria-disabled:opacity-60"
                                                >
                                                    {restoringReview ? "Retrying…" : "Retry restore"}
                                                </button>
                                            ) : (
                                                <button
                                                    type="button"
                                                    onClick={startNewReview}
                                                    className="mt-2 min-h-11 rounded-lg px-2 text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                                                >
                                                    Start new review
                                                </button>
                                            )}
                                        </div>
                                    )}
                                    {generateError && (
                                        <div role="alert" className={`mt-2 rounded-lg px-3 py-2.5 text-sm leading-5 ${providerQueued ? "bg-amber-50 text-amber-900" : "text-red-700"}`}>
                                            <p className="font-medium">{generateErrorTitle}</p>
                                            <p className="mt-1">{generateError}</p>
                                            {providerQueued && (
                                                <button type="button" onClick={() => void generateSuggestion()} disabled={!canGenerate} className="mt-2 min-h-10 rounded-lg px-2 text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-not-allowed disabled:opacity-45">
                                                    Try again
                                                </button>
                                            )}
                                            {documentLocationError && (
                                                <button type="button" onClick={() => void loadDocument()} className="mt-2 min-h-10 rounded-lg px-2 text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
                                                    Refresh document
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </section>
                            </div>
                        )}

                        {activeTab === "review" && (
                            <section id="word-panel-review" role="tabpanel" aria-labelledby="word-tab-review">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h2 id="suggestion-heading" className="text-lg font-semibold leading-6 text-gray-900">Review</h2>
                                    {activeSuggestion && (
                                        <span className={`ml-auto rounded-full px-2 py-1 text-xs font-medium ${suggestionStatusClass(activeSuggestion.status)}`}>
                                            {suggestionStatusLabel(activeSuggestion.status)}
                                        </span>
                                    )}
                                </div>
                                {resumeMessage && (
                                    <p role="status" className="mt-1 text-xs leading-5 text-gray-500">
                                        {resumeMessage}
                                    </p>
                                )}
                                {!suggestion && !generating && !streamingText && (
                                    <div className="mt-3 rounded-xl bg-gray-100 px-3 py-4 text-sm leading-6 text-gray-700">
                                        {sourceText ? "Generate suggestions in Assistant to review them here." : scope === "selection" ? "Select text in Word, then use Assistant to request a suggestion." : "Load the Word document in Assistant, then request a review."}
                                    </div>
                                )}
                                {(suggestion || generating || streamingText) && (
                                    <>
                                        {generating && !suggestion && (
                                            <p role="status" className="mt-3 text-sm leading-5 text-gray-600">Vera is drafting {scope === "document" ? "a review list" : "a suggestion"}. You can return to Assistant to cancel.</p>
                                        )}
                                        {suggestion && activeSuggestion && (
                                            <div className="mt-3 flex items-center border-y border-gray-200 py-2">
                                                <span className="shrink-0 whitespace-nowrap text-sm font-medium text-gray-800">
                                                    Suggestion {activeSuggestionIndex + 1} of {suggestion.items.length}
                                                </span>
                                                {activeSuggestion.status === "pending" && (
                                                    <button
                                                        type="button"
                                                        disabled={!!applying}
                                                        onClick={skipSuggestion}
                                                        className="ml-auto hidden min-h-11 items-center rounded-lg px-2 text-sm font-medium text-gray-600 outline-none hover:bg-gray-100 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-not-allowed disabled:opacity-45 min-[300px]:inline-flex"
                                                    >
                                                        Skip
                                                    </button>
                                                )}
                                                {suggestion.items.length > 1 && (
                                                    <div className={`${activeSuggestion.status === "pending" ? "ml-1" : "ml-auto"} flex shrink-0 gap-1`}>
                                                        <button
                                                            type="button"
                                                            aria-label="Previous suggestion"
                                                            disabled={activeSuggestionIndex === 0 || !!applying}
                                                            onClick={() => showSuggestion(activeSuggestionIndex - 1)}
                                                            className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-600 outline-none hover:bg-gray-100 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-not-allowed disabled:opacity-35"
                                                        >
                                                            <ChevronLeft className="h-4 w-4" />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            aria-label="Next suggestion"
                                                            disabled={activeSuggestionIndex === suggestion.items.length - 1 || !!applying}
                                                            onClick={() => showSuggestion(activeSuggestionIndex + 1)}
                                                            className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-600 outline-none hover:bg-gray-100 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-not-allowed disabled:opacity-35"
                                                        >
                                                            <ChevronRight className="h-4 w-4" />
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        <div className="mt-3 rounded-xl bg-gray-100 p-3">
                                            {activeSuggestion && (
                                                <>
                                                    <p className="text-xs font-medium text-gray-700">Original text</p>
                                                    <del className="mt-1 block text-sm leading-6 text-red-700 decoration-red-700 [line-break:strict] [overflow-wrap:anywhere]">{activeSuggestion.original}</del>
                                                    <div className="my-3 h-px bg-gray-300" />
                                                </>
                                            )}
                                            <p className="text-xs font-medium text-gray-700">{activeSuggestion ? "Proposed replacement" : "Drafting suggestion"}</p>
                                            <ins className="mt-1 block text-pretty text-sm leading-6 text-green-800 no-underline [line-break:strict] [overflow-wrap:anywhere]">{activeSuggestion?.replacement || (scope === "selection" ? streamingText : "…")}</ins>
                                        </div>
                                        {activeSuggestion?.reason && (
                                            <p className="mt-3 text-sm leading-5 text-gray-700">
                                                <span className="font-medium text-gray-900">Why: </span>
                                                {activeSuggestion.reason}
                                            </p>
                                        )}
                                    </>
                                )}
                                {suggestion?.citations.length ? (
                                    <div className="mt-3">
                                        <p className="text-xs font-medium text-gray-700">Sources used</p>
                                        <ul className="mt-1.5 space-y-1 text-sm leading-5 text-gray-700">
                                            {suggestion.citations.slice(0, 3).map((citation, index) => <li key={`${citation.ref}-${index}`} className="break-words">{citationLabel(citation)}</li>)}
                                        </ul>
                                    </div>
                                ) : null}
                                {suggestion && suggestion.citations.length === 0 && (
                                    <div role="status" className="mt-3 rounded-lg bg-amber-50 px-3 py-2.5 text-sm leading-5 text-amber-950">
                                        <p className="font-medium">No Matter source linked</p>
                                        <p className="mt-1">Verify this drafting suggestion against the Word text or the saved Matter chat before applying it.</p>
                                    </div>
                                )}
                                {activeSuggestion && (
                                    <div className="mt-4 space-y-2">
                                        <PillButton tone="black" size="normal" className="min-h-11 w-full" disabled={!canWriteToWord || !!applying} onClick={() => void applySuggestionAsTrackedChange()}>
                                            {applying === "tracked" ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <FilePenLine className="h-4 w-4" />}
                                            Apply as tracked change
                                        </PillButton>
                                        <div className="grid grid-cols-1 gap-2 min-[300px]:grid-cols-2">
                                            <PillButton tone="white" size="normal" className="min-h-11 w-full" disabled={!canWriteToWord || !!applying} onClick={() => void addSuggestionComment()}>
                                                {applying === "comment" ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <MessageSquarePlus className="h-4 w-4" />}
                                                Insert comment
                                            </PillButton>
                                            <button
                                                type="button"
                                                onClick={() => void copySuggestion()}
                                                className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 outline-none transition-colors hover:border-gray-300 hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                                            >
                                                {copied ? <Check className="h-4 w-4 text-emerald-700" /> : <Copy className="h-4 w-4" />}
                                                {copied ? "Copied" : "Copy"}
                                            </button>
                                        </div>
                                        <PillButton tone="white" size="normal" className="min-h-11 w-full" disabled={!canLocateInWord || !!applying} onClick={() => void locateSuggestionInDocument()}>
                                            {applying === "locate" ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <LocateFixed className="h-4 w-4" />}
                                            Locate in document
                                        </PillButton>
                                        {activeSuggestion.status === "pending" && (
                                            <button
                                                type="button"
                                                disabled={!!applying}
                                                onClick={skipSuggestion}
                                                className="mx-auto flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-gray-600 outline-none hover:bg-gray-100 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-not-allowed disabled:opacity-45 min-[300px]:hidden"
                                            >
                                                Skip suggestion
                                            </button>
                                        )}
                                    </div>
                                )}
                                {activeSuggestion?.status === "pending" && !canWriteToWord && !applied && (
                                    <p className="mt-3 text-sm leading-5 text-amber-900">
                                        {writeRestrictionMessage}
                                    </p>
                                )}
                                {applied && (
                                    <div
                                        role="status"
                                        className={`mt-3 flex gap-2 rounded-lg px-3 py-2.5 text-sm leading-5 ${decisionMessageClass(applied.kind)}`}
                                    >
                                        {applied.kind !== "skipped" && <Check className="mt-0.5 h-4 w-4 shrink-0" />}
                                        <span>{applied.message}</span>
                                    </div>
                                )}
                                {actionError && (
                                    <div role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2.5 text-sm leading-5 text-red-800">
                                        <p>{actionError}</p>
                                        {staleOrAmbiguousSelection && (
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    void (restoredSourceMismatch
                                                        ? refreshStaleRestoredSource()
                                                        : scope === "selection"
                                                          ? loadSelection()
                                                          : loadDocument())
                                                }
                                                className="mt-2 min-h-11 rounded-lg px-2 text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                                            >
                                                Refresh {scope === "selection" ? "selection" : "document"}
                                            </button>
                                        )}
                                        {readOnlyDocument && <p className="mt-1">This document cannot be changed from Vera. Copy the suggestion or review document protection in Word.</p>}
                                    </div>
                                )}
                                {suggestion?.chatId && selectedProject && !isPreview && <Link href={`/projects/${selectedProject.id}/assistant/chat/${suggestion.chatId}`} target="_blank" rel="noreferrer" className="mt-3 inline-flex min-h-10 items-center gap-1.5 rounded-lg text-sm font-medium text-blue-700 outline-none hover:text-blue-900 focus-visible:ring-2 focus-visible:ring-blue-600">Open saved Matter chat <ExternalLink className="h-3.5 w-3.5" /></Link>}
                                {activeSuggestion && <p className="mt-3 text-sm leading-5 text-gray-600">Each suggestion requires a separate decision. Vera never accepts Word changes automatically.</p>}
                            </section>
                        )}

                        {activeTab === "actions" && (
                            <section id="word-panel-actions" role="tabpanel" aria-labelledby="word-tab-actions">
                                <h2 id="actions-heading" className="text-lg font-semibold leading-6 text-gray-900">Actions</h2>
                                <p className="mt-1 text-sm leading-5 text-gray-600">Start a focused request with the current {scope === "selection" ? "Word selection" : "document"}.</p>
                                {sourceText ? (
                                    <div className="mt-4 space-y-2">
                                        {ACTION_SHORTCUTS.map((shortcut) => (
                                            <button key={shortcut.label} type="button" disabled={generating || restoringReview} onClick={() => applyActionShortcut(shortcut)} className="flex min-h-10 w-full items-center justify-between rounded-lg border border-gray-200 bg-white px-3 text-left text-sm font-medium text-gray-800 outline-none transition-colors hover:border-gray-300 hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-not-allowed disabled:opacity-50">
                                                <span>{shortcut.label}</span><span className="text-xs font-normal text-gray-500">Use in Assistant</span>
                                            </button>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="mt-4 rounded-xl bg-gray-100 px-3 py-4 text-sm leading-6 text-gray-700">{scope === "selection" ? "Select text in Word before choosing an action." : "Load the Word document before choosing an action."}</div>
                                )}
                            </section>
                        )}

                        {activeTab === "assistant" && !projectsLoading && projects.length === 0 && (
                            <Link href="/projects" target="_blank" className="mt-6 inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg bg-gray-950 px-4 text-sm font-medium text-white outline-none hover:bg-gray-900 focus-visible:ring-2 focus-visible:ring-blue-600">Open Matters in Vera <ExternalLink className="h-3.5 w-3.5" /></Link>
                        )}
                    </main>
                </div>
            </div>
        </>
    );
}
