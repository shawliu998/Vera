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
    Save,
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
import {
    fetchDocxBytes,
    invalidateDocxBytes,
} from "@/app/hooks/useFetchDocxBytes";
import type {
    Citation,
    Document as MatterDocument,
    Project,
} from "@/app/components/shared/types";
import {
    getChat,
    getProject,
    listProjects,
    MikeApiError,
    streamProjectChat,
} from "@/app/lib/mikeApi";
import { getAgentTask } from "@/app/lib/agentClient";
import { useSelectedModel } from "@/app/hooks/useSelectedModel";
import {
    applyTrackedReplacementAtAnchor,
    applyTrackedReplacement,
    detectWordHost,
    insertSuggestionCommentAtAnchor,
    insertSuggestionComment,
    locateWordAnchor,
    readCurrentWordDocumentContext,
    readCurrentWordCustomProperties,
    readCurrentWordSelection,
    type WordHostState,
} from "@/app/lib/wordOfficeBridge";
import {
    listMatterWordDocuments,
    loadMatterDocumentVersionBase,
    saveCurrentWordDocumentAsMatterVersion,
    saveCurrentWordDocumentAsTaskArtifactVersion,
    type MatterDocumentVersionBase,
} from "@/app/lib/wordMatterVersion";
import {
    assertWordTaskArtifactServerBinding,
    classifyWordTaskArtifactBinding,
    sameWordTaskArtifactIdentity,
    type WordTaskArtifactBinding,
    type WordTaskArtifactBindingClassification,
} from "@/app/lib/wordTaskArtifactBinding";
import {
    buildWordDocumentReviewPrompt,
    buildWordSuggestionPrompt,
    findLocatedReviewStandardCitation,
    findReviewStandardCitation,
    highestCitationRef,
    isDeterministicReviewStandardSourceError,
    offsetCitationRefs,
    offsetReviewStandardCitationRefs,
    parseWordDocumentSuggestions,
    readWordSuggestionStream,
    ReviewStandardSourceValidationError,
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
        documents: [
            {
                id: "preview-document",
                user_id: "preview-user",
                project_id: "preview-matter",
                filename: "Master Services Agreement.docx",
                file_type: "docx",
                storage_path: "preview/master-services-agreement.docx",
                pdf_storage_path: null,
                size_bytes: 48_000,
                page_count: 7,
                structure_tree: null,
                status: "ready",
                created_at: "2026-07-21T00:00:00.000Z",
                active_version_number: 2,
            },
            {
                id: "preview-review-standard",
                user_id: "preview-user",
                project_id: "preview-matter",
                filename: "Customer Contract Playbook.docx",
                file_type: "docx",
                storage_path: "preview/customer-contract-playbook.docx",
                pdf_storage_path: null,
                size_bytes: 18_000,
                page_count: 4,
                structure_tree: null,
                status: "ready",
                created_at: "2026-07-21T00:00:00.000Z",
                active_version_number: 1,
            },
        ],
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

type ReviewStandard = {
    documentId: string;
    filename: string;
};

type ReviewStandardVerification =
    | "not-required"
    | "checking"
    | "verified"
    | "blocked";

type SuggestionState = {
    items: ReviewSuggestion[];
    instruction: string;
    citations: Citation[];
    chatId: string | null;
    scope: WordReviewScope;
    reviewStandard: ReviewStandard | null;
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
type WordTaskArtifactBindingState =
    | WordTaskArtifactBindingClassification
    | { kind: "checking" }
    | { kind: "read-error"; error: string };

function isReviewStandardDocument(document: MatterDocument): boolean {
    return (
        document.file_type?.toLowerCase() === "docx" ||
        /\.docx$/i.test(document.filename)
    );
}

function reviewStandardCitationError(
    filename: string,
): ReviewStandardSourceValidationError {
    return new ReviewStandardSourceValidationError(
        `Playbook source missing: Vera could not uniquely locate every cited quote in ${filename}. Generate the review again before writing to Word.`,
    );
}

function isReviewStandardSourceVerificationError(error: unknown): boolean {
    return readableError(error).startsWith("Playbook source missing:");
}

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

function citationDocumentHref(
    projectId: string,
    citation: Citation,
): string | null {
    if (citation.kind === "case") return null;
    const query = new URLSearchParams({ open_document: citation.document_id });
    if (citation.version_id) query.set("version_id", citation.version_id);
    if (citation.page !== undefined && citation.page !== null) {
        query.set("page", String(citation.page));
    }
    const quote = citation.quotes?.[0]?.quote ?? citation.quote;
    if (quote.trim()) query.set("quote", quote);
    return `/projects/${projectId}?${query.toString()}`;
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
    const previewScenario = searchParams.get("scenario");
    const isPlaybookPreview =
        previewMode === "playbook" ||
        previewMode === "playbook-missing" ||
        previewMode === "playbook-unlocated" ||
        (previewMode === "ready" &&
            (previewScenario === "playbook" ||
                previewScenario === "playbook-missing" ||
                previewScenario === "playbook-unlocated"));
    const isPlaybookMissingPreview =
        previewMode === "playbook-missing" ||
        (previewMode === "ready" && previewScenario === "playbook-missing");
    const isPlaybookUnlocatedPreview =
        previewMode === "playbook-unlocated" ||
        (previewMode === "ready" && previewScenario === "playbook-unlocated");
    const isPreview = [
        "ready",
        "empty",
        "progress",
        "retrying",
        "restore-retry",
        "restore-unavailable",
        "playbook",
        "playbook-missing",
        "playbook-unlocated",
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
    const [matterDocuments, setMatterDocuments] = useState<MatterDocument[]>([]);
    const [matterDocumentsLoading, setMatterDocumentsLoading] = useState(false);
    const [matterDocumentError, setMatterDocumentError] = useState<string | null>(null);
    const [selectedMatterDocumentId, setSelectedMatterDocumentId] = useState("");
    const [selectedReviewStandardDocumentId, setSelectedReviewStandardDocumentId] =
        useState("");
    const [matterDocumentVersionBase, setMatterDocumentVersionBase] =
        useState<MatterDocumentVersionBase | null>(null);
    const [matterVersionLoading, setMatterVersionLoading] = useState(false);
    const [matterVersionSaving, setMatterVersionSaving] = useState(false);
    const [matterVersionMessage, setMatterVersionMessage] = useState<string | null>(null);
    const [taskArtifactBindingState, setTaskArtifactBindingState] =
        useState<WordTaskArtifactBindingState>({ kind: "checking" });
    const [taskArtifactServerVerified, setTaskArtifactServerVerified] =
        useState(false);
    const [taskArtifactReopenRequired, setTaskArtifactReopenRequired] =
        useState(false);
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
    // This is deliberately ephemeral: it gates the consequential Word write
    // while the existing Matter citation is re-located in its cited version.
    const [reviewStandardVerification, setReviewStandardVerification] =
        useState<ReviewStandardVerification>("not-required");
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
    const reviewStandardTextCacheRef = useRef(
        new Map<string, Promise<string>>(),
    );

    const taskArtifactBinding: WordTaskArtifactBinding | null =
        taskArtifactBindingState.kind === "bound"
            ? taskArtifactBindingState.binding
            : null;
    const taskArtifactIdentityError =
        "The current document is not this Task's current Word artifact. Reopen it from Vera.";
    const taskArtifactPartialSaveMessage =
        "The new version was saved, but Vera could not update the open Word state. Reopen the current artifact from its Task before editing again.";

    const selectedProject = useMemo(
        () => projects.find((project) => project.id === selectedProjectId) ?? null,
        [projects, selectedProjectId],
    );
    const selectedMatterDocument = useMemo(
        () =>
            matterDocuments.find(
                (document) => document.id === selectedMatterDocumentId,
            ) ?? null,
        [matterDocuments, selectedMatterDocumentId],
    );
    const taskArtifactIdentityMatches =
        taskArtifactBinding !== null &&
        taskArtifactServerVerified &&
        sameWordTaskArtifactIdentity(
            selectedProjectId,
            taskArtifactBinding.projectId,
        ) &&
        selectedMatterDocument !== null &&
        sameWordTaskArtifactIdentity(
            selectedMatterDocument.id,
            taskArtifactBinding.documentId,
        ) &&
        matterDocumentVersionBase !== null &&
        sameWordTaskArtifactIdentity(
            matterDocumentVersionBase.documentId,
            taskArtifactBinding.documentId,
        ) &&
        sameWordTaskArtifactIdentity(
            matterDocumentVersionBase.versionId,
            taskArtifactBinding.versionId,
        );
    const taskArtifactSaveBlocked =
        taskArtifactReopenRequired ||
        taskArtifactBindingState.kind === "checking" ||
        taskArtifactBindingState.kind === "read-error" ||
        taskArtifactBindingState.kind === "invalid" ||
        (taskArtifactBinding !== null && !taskArtifactIdentityMatches);
    const reviewStandardDocuments = useMemo(
        () =>
            matterDocuments.filter(
                (document) =>
                    document.status === "ready" &&
                    isReviewStandardDocument(document),
            ),
        [matterDocuments],
    );
    const selectedReviewStandardDocument = useMemo(
        () =>
            reviewStandardDocuments.find(
                (document) => document.id === selectedReviewStandardDocumentId,
            ) ?? null,
        [reviewStandardDocuments, selectedReviewStandardDocumentId],
    );

    const activeSuggestion = suggestion?.items[activeSuggestionIndex] ?? null;
    const sourceText = scope === "selection" ? selection : documentText;
    const sourcePreview =
        scope === "document" && sourceText.length > 1_200
            ? `${sourceText.slice(0, 1_200)}…`
            : sourceText;

    const loadReviewStandardText = useCallback(
        async (
            documentId: string,
            versionId: string,
            force = false,
        ): Promise<string> => {
            const key = `${documentId}:${versionId}`;
            const cached = reviewStandardTextCacheRef.current.get(key);
            if (cached && !force) return cached;
            if (force) {
                reviewStandardTextCacheRef.current.delete(key);
                invalidateDocxBytes(documentId, versionId);
            }

            const pending = (async () => {
                // Keep transport/module-loading failures distinguishable from
                // deterministic DOCX content failures. Restore can retry the
                // former without discarding its saved Matter-chat pointer.
                const bytes = await fetchDocxBytes(documentId, versionId);
                const { extractAcceptedDocxText } = await import(
                    "@/app/lib/docxAcceptedView"
                );
                let text: string;
                try {
                    text = await extractAcceptedDocxText(bytes);
                } catch (error) {
                    throw new ReviewStandardSourceValidationError(
                        "The Matter standard content could not be read.",
                        { cause: error },
                    );
                }
                // Match the existing Matter reader's exceptional fallback for
                // legacy or malformed DOCX packages with no readable body.
                if (!text.trim()) {
                    const { default: mammoth } = await import("mammoth");
                    try {
                        const extracted = await mammoth.extractRawText({
                            arrayBuffer: bytes,
                        });
                        text = extracted.value;
                    } catch (error) {
                        throw new ReviewStandardSourceValidationError(
                            "The Matter standard content could not be read.",
                            { cause: error },
                        );
                    }
                }
                if (!text.trim()) {
                    throw new ReviewStandardSourceValidationError(
                        "The Matter standard has no readable text.",
                    );
                }
                return text;
            })();
            reviewStandardTextCacheRef.current.set(key, pending);
            void pending.catch(() => {
                if (reviewStandardTextCacheRef.current.get(key) === pending) {
                    reviewStandardTextCacheRef.current.delete(key);
                }
            });
            return pending;
        },
        [],
    );

    const verifyReviewStandardSources = useCallback(
        async (input: {
            reviewStandard: ReviewStandard;
            items: WordSuggestionItem[];
            citations: Citation[];
            force?: boolean;
        }) => {
            if (!input.items.length) return;
            const mappedCitations = input.items.map((item) =>
                findReviewStandardCitation(
                    input.citations,
                    input.reviewStandard.documentId,
                    item.standardCitationRef,
                ),
            );
            if (mappedCitations.some((citation) => !citation)) {
                throw reviewStandardCitationError(input.reviewStandard.filename);
            }

            const versionIds = new Set(
                mappedCitations.map((citation) =>
                    citation?.kind === "case" ? null : citation?.version_id ?? null,
                ),
            );
            if (versionIds.size !== 1) {
                throw reviewStandardCitationError(input.reviewStandard.filename);
            }
            const [versionId] = versionIds;
            if (!versionId) {
                throw reviewStandardCitationError(input.reviewStandard.filename);
            }

            let sourceText: string;
            try {
                sourceText = await loadReviewStandardText(
                    input.reviewStandard.documentId,
                    versionId,
                    input.force,
                );
            } catch (error) {
                if (isDeterministicReviewStandardSourceError(error)) {
                    throw reviewStandardCitationError(
                        input.reviewStandard.filename,
                    );
                }
                throw error;
            }
            if (
                input.items.some(
                    (item) =>
                        !findLocatedReviewStandardCitation(
                            input.citations,
                            input.reviewStandard.documentId,
                            item.standardCitationRef,
                            sourceText,
                        ),
                )
            ) {
                throw reviewStandardCitationError(input.reviewStandard.filename);
            }
        },
        [loadReviewStandardText],
    );

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
            setReviewStandardVerification("not-required");
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
            setReviewStandardVerification("not-required");
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
        if (isPreview) {
            setTaskArtifactBindingState({ kind: "absent" });
            setTaskArtifactServerVerified(false);
            setTaskArtifactReopenRequired(false);
            return;
        }
        if (host.kind !== "word") {
            setTaskArtifactBindingState({ kind: "checking" });
            setTaskArtifactServerVerified(false);
            return;
        }
        let cancelled = false;
        setTaskArtifactBindingState({ kind: "checking" });
        setTaskArtifactServerVerified(false);
        setTaskArtifactReopenRequired(false);
        void readCurrentWordCustomProperties()
            .then((properties) => {
                if (cancelled) return;
                const classification =
                    classifyWordTaskArtifactBinding(properties);
                setTaskArtifactBindingState(classification);
                if (classification.kind === "bound") {
                    setSelectedProjectId(classification.binding.projectId);
                } else if (classification.kind === "invalid") {
                    setMatterDocumentError(taskArtifactIdentityError);
                }
            })
            .catch((error) => {
                if (!cancelled) {
                    const message = readableError(error);
                    setTaskArtifactBindingState({
                        kind: "read-error",
                        error: message,
                    });
                    setMatterDocumentError(message);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [host.kind, isPreview, taskArtifactIdentityError]);

    useEffect(() => {
        setTaskArtifactServerVerified(false);
        if (isPreview || host.kind !== "word" || !taskArtifactBinding) {
            return;
        }
        let cancelled = false;
        void getAgentTask(taskArtifactBinding.taskId)
            .then((snapshot) => {
                if (cancelled) return;
                assertWordTaskArtifactServerBinding(
                    taskArtifactBinding,
                    snapshot,
                );
                setSelectedProjectId(taskArtifactBinding.projectId);
                setScope("document");
                setTaskArtifactServerVerified(true);
            })
            .catch((error) => {
                if (!cancelled) setMatterDocumentError(readableError(error));
            });
        return () => {
            cancelled = true;
        };
    }, [host.kind, isPreview, taskArtifactBinding]);

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
        const previewReviewStandard = isPlaybookPreview
            ? {
                  documentId: "preview-review-standard",
                  filename: "Customer Contract Playbook.docx",
              }
            : null;
        const previewScope: WordReviewScope = isPlaybookPreview
            ? "document"
            : scope;
        if (isPlaybookPreview) {
            setScope("document");
            setSelectedReviewStandardDocumentId(
                "preview-review-standard",
            );
        } else {
            setSelectedReviewStandardDocumentId("");
        }
        if (previewMode === "ready" || isPlaybookPreview) {
            setSuggestion({
                items:
                    previewScope === "document" && searchParams.get("lang") !== "zh"
                        ? PREVIEW_DOCUMENT_SUGGESTIONS.map((item, index) => ({
                              ...item,
                              ...(previewReviewStandard
                                  ? {
                                        standard:
                                            "The customer playbook requires 30 days' prior written notice and an exit right before revised fees apply.",
                                        deviation:
                                            index === 0
                                                ? "The draft permits fee changes at any time."
                                                : "The draft requires payment within 10 days even for disputed amounts.",
                                        standardCitationRef: index + 1,
                                    }
                                  : {}),
                              status: "pending" as const,
                          }))
                        : [
                              {
                                  id: "word-suggestion-1",
                                  original: previewContent.selection,
                                  replacement: previewContent.suggestion,
                                  reason: "Addresses the requested legal and drafting issue with a precise replacement.",
                                  ...(previewReviewStandard
                                      ? {
                                            standard:
                                                "客户合同指引要求至少提前三十日书面通知，并允许客户在新费用生效前解除。",
                                            deviation:
                                                "当前条款允许供应商立即调整费用，且未提供无责解除权。",
                                            standardCitationRef: 1,
                                        }
                                      : {}),
                                  status: "pending" as const,
                              },
                          ],
                instruction: previewContent.instruction,
                chatId: "preview-chat",
                citations: previewReviewStandard
                    ? isPlaybookMissingPreview
                        ? []
                        : [
                              {
                                  type: "citation_data",
                                  kind: "document",
                                  ref: 1,
                                  doc_id: "doc-0",
                                  document_id: "preview-review-standard",
                                  version_id: "preview-standard-v1",
                                  version_number: 1,
                                  filename:
                                      "Customer Contract Playbook.docx",
                                  page: 2,
                                  quote:
                                      isPlaybookUnlocatedPreview
                                          ? "The playbook requires an unavailable pricing protection."
                                          : "Supplier must give at least 30 days' prior written notice before a fee change.",
                              },
                              {
                                  type: "citation_data",
                                  kind: "document",
                                  ref: 2,
                                  doc_id: "doc-0",
                                  document_id: "preview-review-standard",
                                  version_id: "preview-standard-v1",
                                  version_number: 1,
                                  filename:
                                      "Customer Contract Playbook.docx",
                                  page: 3,
                                  quote:
                                      "Payment terms must exclude disputed amounts and provide a commercially workable payment period.",
                              },
                          ]
                    : [
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
                scope: previewScope,
                reviewStandard: previewReviewStandard,
            });
            setReviewStandardVerification(
                previewReviewStandard
                    ? isPlaybookMissingPreview || isPlaybookUnlocatedPreview
                        ? "blocked"
                        : "verified"
                    : "not-required",
            );
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
    }, [
        isPlaybookMissingPreview,
        isPlaybookPreview,
        isPlaybookUnlocatedPreview,
        isPreview,
        previewContent,
        previewMode,
        previewScenario,
        scope,
        searchParams,
    ]);

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
        setMatterDocuments([]);
        setSelectedMatterDocumentId("");
        setSelectedReviewStandardDocumentId("");
        setMatterDocumentVersionBase(null);
        setMatterDocumentError(null);
        setMatterVersionMessage(null);
        if (!selectedProjectId) {
            setMatterDocumentsLoading(false);
            return;
        }

        const applyProjectDocuments = (project: Project) => {
            const documents = listMatterWordDocuments(project);
            setMatterDocuments(documents);
            if (
                resumePointer?.projectId === project.id &&
                resumePointer.documentId &&
                resumePointer.baseVersionId &&
                resumePointer.baseVersionNumber !== undefined &&
                documents.some(
                    (document) => document.id === resumePointer.documentId,
                )
            ) {
                setSelectedMatterDocumentId(resumePointer.documentId);
                setMatterDocumentVersionBase({
                    documentId: resumePointer.documentId,
                    versionId: resumePointer.baseVersionId,
                    versionNumber: resumePointer.baseVersionNumber,
                });
            }
            if (
                resumePointer?.projectId === project.id &&
                resumePointer.reviewStandardDocumentId &&
                documents.some(
                    (document) =>
                        document.id === resumePointer.reviewStandardDocumentId &&
                        document.status === "ready" &&
                        isReviewStandardDocument(document),
                )
            ) {
                setSelectedReviewStandardDocumentId(
                    resumePointer.reviewStandardDocumentId,
                );
            } else if (
                isPlaybookPreview &&
                documents.some(
                    (document) =>
                        document.id === "preview-review-standard" &&
                        document.status === "ready" &&
                        isReviewStandardDocument(document),
                )
            ) {
                setSelectedReviewStandardDocumentId(
                    "preview-review-standard",
                );
            }
        };

        if (isPreview) {
            const project = projects.find(
                (candidate) => candidate.id === selectedProjectId,
            );
            if (project) applyProjectDocuments(project);
            setMatterDocumentsLoading(false);
            return;
        }

        let cancelled = false;
        setMatterDocumentsLoading(true);
        void getProject(selectedProjectId)
            .then((project) => {
                if (!cancelled) applyProjectDocuments(project);
            })
            .catch((error) => {
                if (!cancelled) setMatterDocumentError(readableError(error));
            })
            .finally(() => {
                if (!cancelled) setMatterDocumentsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [
        isPlaybookPreview,
        isPreview,
        projects,
        resumePointer,
        selectedProjectId,
    ]);

    useEffect(() => {
        if (
            isPreview ||
            host.kind !== "word" ||
            !taskArtifactBinding ||
            !taskArtifactServerVerified
        ) {
            return;
        }
        if (
            !sameWordTaskArtifactIdentity(
                selectedProjectId,
                taskArtifactBinding.projectId,
            )
        ) {
            setSelectedProjectId(taskArtifactBinding.projectId);
            return;
        }
        if (matterDocumentsLoading || matterDocuments.length === 0) return;
        const document = matterDocuments.find((candidate) =>
            sameWordTaskArtifactIdentity(
                candidate.id,
                taskArtifactBinding.documentId,
            ),
        );
        if (!document) {
            setMatterDocumentError(taskArtifactIdentityError);
            return;
        }
        if (
            sameWordTaskArtifactIdentity(
                selectedMatterDocumentId,
                document.id,
            ) &&
            matterDocumentVersionBase &&
            sameWordTaskArtifactIdentity(
                matterDocumentVersionBase.documentId,
                document.id,
            )
        ) {
            return;
        }
        let cancelled = false;
        setSelectedMatterDocumentId(document.id);
        setMatterDocumentVersionBase(null);
        setMatterDocumentError(null);
        setMatterVersionMessage(null);
        setMatterVersionLoading(true);
        void loadMatterDocumentVersionBase(document.id)
            .then((base) => {
                if (cancelled) return;
                setMatterDocumentVersionBase(base);
                if (
                    !sameWordTaskArtifactIdentity(
                        base.versionId,
                        taskArtifactBinding.versionId,
                    )
                ) {
                    setMatterDocumentError(taskArtifactIdentityError);
                }
            })
            .catch((error) => {
                if (!cancelled) setMatterDocumentError(readableError(error));
            })
            .finally(() => {
                if (!cancelled) setMatterVersionLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [
        host.kind,
        isPreview,
        matterDocumentVersionBase,
        matterDocuments,
        matterDocumentsLoading,
        selectedMatterDocumentId,
        selectedProjectId,
        taskArtifactBinding,
        taskArtifactIdentityError,
        taskArtifactServerVerified,
    ]);

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
        setReviewStandardVerification(
            resumePointer.reviewStandardDocumentId
                ? "checking"
                : "not-required",
        );
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
                const restoredReviewStandard =
                    resumePointer.reviewStandardDocumentId &&
                    resumePointer.reviewStandardFilename
                        ? {
                              documentId:
                                  resumePointer.reviewStandardDocumentId,
                              filename: resumePointer.reviewStandardFilename,
                          }
                        : null;
                if (restoredReviewStandard) {
                    try {
                        await verifyReviewStandardSources({
                            reviewStandard: restoredReviewStandard,
                            items: restored.items,
                            citations: restored.citations,
                        });
                    } catch (error) {
                        if (
                            isDeterministicReviewStandardSourceError(error)
                        ) {
                            throw new SavedReviewRestoreError(error);
                        }
                        throw error;
                    }
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

                setReviewStandardVerification(
                    restoredReviewStandard ? "verified" : "not-required",
                );
                setMode(restored.mode);
                setInstruction(restored.instruction);
                setSuggestion({
                    items: restored.items,
                    instruction: restored.instruction,
                    citations: restored.citations,
                    chatId: restored.chatId,
                    scope: restored.scope,
                    reviewStandard:
                        resumePointer.reviewStandardDocumentId &&
                        resumePointer.reviewStandardFilename
                            ? {
                                  documentId:
                                      resumePointer.reviewStandardDocumentId,
                                  filename: resumePointer.reviewStandardFilename,
                              }
                            : null,
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
                    setReviewStandardVerification("blocked");
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
                    setReviewStandardVerification(
                        resumePointer.reviewStandardDocumentId
                            ? "blocked"
                            : "not-required",
                    );
                    setResumeIssue({
                        kind: "retry",
                        message: `Vera could not restore the saved review. ${readableError(error)}`,
                    });
                    return;
                }
                if (typeof window !== "undefined") {
                    clearWordReviewSessionPointer(window.localStorage);
                }
                setReviewStandardVerification("blocked");
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
        verifyReviewStandardSources,
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
            ...(selectedMatterDocument && matterDocumentVersionBase
                ? {
                      documentId: selectedMatterDocument.id,
                      baseVersionId: matterDocumentVersionBase.versionId,
                      baseVersionNumber:
                          matterDocumentVersionBase.versionNumber,
                  }
                : {}),
            ...(suggestion.reviewStandard
                ? {
                      reviewStandardDocumentId:
                          suggestion.reviewStandard.documentId,
                      reviewStandardFilename: suggestion.reviewStandard.filename,
                  }
                : {}),
        });
    }, [
        activeSuggestionIndex,
        isPreview,
        matterDocumentVersionBase,
        mode,
        selectedProjectId,
        selectedMatterDocument,
        suggestion,
    ]);

    useEffect(
        () => () => {
            abortRef.current?.abort();
        },
        [],
    );

    async function selectMatterDocumentTarget(documentId: string) {
        setSelectedMatterDocumentId(documentId);
        setMatterDocumentVersionBase(null);
        setMatterDocumentError(null);
        setMatterVersionMessage(null);
        if (!documentId) return;

        if (isPreview) {
            const document = matterDocuments.find(
                (candidate) => candidate.id === documentId,
            );
            setMatterDocumentVersionBase({
                documentId,
                versionId: "preview-version-2",
                versionNumber: document?.active_version_number ?? 2,
            });
            return;
        }

        setMatterVersionLoading(true);
        try {
            setMatterDocumentVersionBase(
                await loadMatterDocumentVersionBase(documentId),
            );
        } catch (error) {
            setMatterDocumentError(readableError(error));
        } finally {
            setMatterVersionLoading(false);
        }
    }

    async function saveWordDocumentVersion() {
        if (
            !selectedMatterDocument ||
            !matterDocumentVersionBase ||
            host.kind !== "word"
        ) {
            return;
        }
        if (taskArtifactSaveBlocked) {
            setMatterDocumentError(
                taskArtifactReopenRequired
                    ? taskArtifactPartialSaveMessage
                    : taskArtifactBindingState.kind === "read-error"
                      ? taskArtifactBindingState.error
                      : taskArtifactIdentityError,
            );
            return;
        }
        setMatterVersionSaving(true);
        setMatterDocumentError(null);
        setMatterVersionMessage(null);
        try {
            if (taskArtifactBinding) {
                const saved =
                    await saveCurrentWordDocumentAsTaskArtifactVersion({
                        taskId: taskArtifactBinding.taskId,
                        projectId: taskArtifactBinding.projectId,
                        deliverableKey: taskArtifactBinding.deliverableKey,
                        document: selectedMatterDocument,
                        base: matterDocumentVersionBase,
                        openBinding: taskArtifactBinding,
                    });
                setMatterDocumentVersionBase({
                    documentId: selectedMatterDocument.id,
                    versionId: saved.version.id,
                    versionNumber: saved.version.version_number,
                });
                if (saved.receiptSynchronized) {
                    setTaskArtifactBindingState({
                        kind: "bound",
                        binding: saved.successorBinding,
                    });
                    setTaskArtifactServerVerified(true);
                    setTaskArtifactReopenRequired(false);
                    setMatterVersionMessage(
                        saved.version.version_number
                            ? `Saved ${selectedMatterDocument.filename} as V${saved.version.version_number}.`
                            : `Saved ${selectedMatterDocument.filename} as a new version.`,
                    );
                } else {
                    setTaskArtifactReopenRequired(true);
                    setMatterVersionMessage(taskArtifactPartialSaveMessage);
                }
                return;
            }
            const version = await saveCurrentWordDocumentAsMatterVersion({
                document: selectedMatterDocument,
                base: matterDocumentVersionBase,
            });
            setMatterDocumentVersionBase({
                documentId: selectedMatterDocument.id,
                versionId: version.id,
                versionNumber: version.version_number,
            });
            setMatterVersionMessage(
                version.version_number
                    ? `Saved ${selectedMatterDocument.filename} as V${version.version_number}.`
                    : `Saved ${selectedMatterDocument.filename} as a new version.`,
            );
        } catch (error) {
            setMatterDocumentError(readableError(error));
        } finally {
            setMatterVersionSaving(false);
        }
    }

    async function generateSuggestion() {
        if (!selectedProjectId || !sourceText.trim() || !instruction.trim()) return;
        const reviewStandard =
            scope === "document" ? selectedReviewStandardDocument : null;
        setReviewStandardVerification(
            reviewStandard ? "checking" : "not-required",
        );
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
                    scope === "document" && searchParams.get("lang") !== "zh"
                        ? PREVIEW_DOCUMENT_SUGGESTIONS.map((item, index) => ({
                              ...item,
                              ...(reviewStandard
                                  ? {
                                        standard:
                                            "The customer playbook requires 30 days' prior written notice and an exit right before revised fees apply.",
                                        deviation:
                                            "The draft does not include the applicable customer-side protection.",
                                        standardCitationRef: index + 1,
                                    }
                                  : {}),
                              status: "pending" as const,
                          }))
                        : [
                              {
                                  id: "word-suggestion-1",
                                  original: selection,
                                  replacement: previewContent.suggestion,
                                  reason: "Addresses the requested legal and drafting issue with a precise replacement.",
                                  ...(reviewStandard
                                      ? {
                                            standard:
                                                "客户合同指引要求至少提前三十日书面通知，并允许客户在新费用生效前解除。",
                                            deviation:
                                                "当前条款允许供应商立即调整费用，且未提供无责解除权。",
                                            standardCitationRef: 1,
                                        }
                                      : {}),
                                  status: "pending" as const,
                              },
                          ],
                instruction: instruction.trim(),
                chatId: "preview-chat",
                citations: reviewStandard
                    ? [
                          {
                              type: "citation_data",
                              kind: "document",
                              ref: 1,
                              doc_id: "doc-0",
                              document_id: reviewStandard.id,
                              version_id: "preview-standard-v1",
                              version_number: 1,
                              filename: reviewStandard.filename,
                              page: 2,
                              quote:
                                  isPlaybookUnlocatedPreview
                                      ? "The playbook requires an unavailable pricing protection."
                                      : "Supplier must give at least 30 days' prior written notice before a fee change.",
                          },
                          {
                              type: "citation_data",
                              kind: "document",
                              ref: 2,
                              doc_id: "doc-0",
                              document_id: reviewStandard.id,
                              version_id: "preview-standard-v1",
                              version_number: 1,
                              filename: reviewStandard.filename,
                              page: 3,
                              quote:
                                  "Payment terms must exclude disputed amounts and provide a commercially workable payment period.",
                          },
                      ]
                    : [],
                scope,
                reviewStandard: reviewStandard
                    ? {
                          documentId: reviewStandard.id,
                          filename: reviewStandard.filename,
                      }
                    : null,
            });
            setReviewStandardVerification(
                reviewStandard
                    ? isPlaybookMissingPreview || isPlaybookUnlocatedPreview
                        ? "blocked"
                        : "verified"
                    : "not-required",
            );
            setActiveTab("review");
            focusTaskPaneTab("review");
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
                          reviewStandard: reviewStandard
                              ? { filename: reviewStandard.filename }
                              : null,
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
                            messages: [
                                {
                                    role: "user",
                                    content: prompt,
                                    ...(reviewStandard
                                        ? {
                                              files: [
                                                  {
                                                      filename:
                                                          reviewStandard.filename,
                                                      document_id:
                                                          reviewStandard.id,
                                                  },
                                              ],
                                          }
                                        : {}),
                                },
                            ],
                            ...(chatId ? { chat_id: chatId } : {}),
                            ...(reviewStandard
                                ? {
                                      attached_documents: [
                                          {
                                              filename: reviewStandard.filename,
                                              document_id: reviewStandard.id,
                                          },
                                      ],
                                  }
                                : {}),
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
                const citationRefOffset = reviewStandard
                    ? highestCitationRef(citations)
                    : 0;
                const responseCitations = reviewStandard
                    ? offsetCitationRefs(result.citations, citationRefOffset)
                    : result.citations;
                let nextItems = segments
                    ? parseWordDocumentSuggestions(result.text, segments[index].text, {
                          paragraphStart: segments[index].paragraphStart,
                          idOffset: items.length,
                          requiresReviewStandard: Boolean(reviewStandard),
                      })
                    : [
                          {
                              id: "word-suggestion-1",
                              original: selection,
                              replacement: result.text,
                              reason: "Addresses the instruction for the selected Word text.",
                          },
                      ];
                if (reviewStandard) {
                    nextItems = offsetReviewStandardCitationRefs(
                        nextItems,
                        citationRefOffset,
                    );
                }
                if (
                    reviewStandard &&
                    nextItems.some(
                        (item) =>
                            !findReviewStandardCitation(
                                responseCitations,
                                reviewStandard.id,
                                item.standardCitationRef,
                            ),
                    )
                ) {
                    throw new Error(
                        `Playbook source missing: ${reviewStandard.filename} was not cited for every suggestion. Generate the review again before writing to Word.`,
                    );
                }
                if (reviewStandard) {
                    await verifyReviewStandardSources({
                        reviewStandard: {
                            documentId: reviewStandard.id,
                            filename: reviewStandard.filename,
                        },
                        items: [...items, ...nextItems],
                        citations: [...citations, ...responseCitations],
                    });
                    setReviewStandardVerification("verified");
                }
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
                citations = [...citations, ...responseCitations];
                if (items.length) {
                    // Completed sections remain usable if a later model request
                    // is cancelled. The existing session pointer restores them.
                    setSuggestion({
                        items: items.map((item) => ({ ...item, status: "pending" })),
                        instruction: instruction.trim(),
                        citations,
                        chatId,
                        scope,
                        reviewStandard: reviewStandard
                            ? {
                                  documentId: reviewStandard.id,
                                  filename: reviewStandard.filename,
                              }
                            : null,
                    });
                }
            }
            if (!items.length) {
                throw new Error("Vera did not identify any changes in this document.");
            }
            setActiveTab("review");
            focusTaskPaneTab("review");
        } catch (error) {
            // A completed segment has already passed exact source relocation.
            // Keep it usable when a later segment is cancelled or the provider
            // fails. Only a source-verification failure, or no completed
            // suggestions at all, may block the consequential Word write.
            if (
                reviewStandard &&
                (!completedItemCount ||
                    isReviewStandardSourceVerificationError(error))
            ) {
                setReviewStandardVerification("blocked");
            }
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
        if (nextScope === "selection") {
            setSelectedReviewStandardDocumentId("");
        }
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

    function focusTaskPaneTab(tab: TaskPaneTab) {
        window.setTimeout(
            () => document.getElementById(`word-tab-${tab}`)?.focus(),
            0,
        );
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

    async function confirmReviewStandardBeforeWrite() {
        if (!suggestion?.reviewStandard) return;
        // This action is only reachable once the existing suggestion has
        // already passed an exact source relocation. Keep that verified state
        // on a transport failure so the user can try the same consequential
        // action again; the action itself still fails closed on this attempt.
        const priorVerification = reviewStandardVerification;
        setReviewStandardVerification("checking");
        try {
            await verifyReviewStandardSources({
                reviewStandard: suggestion.reviewStandard,
                items: suggestion.items,
                citations: suggestion.citations,
                force: true,
            });
            setReviewStandardVerification("verified");
        } catch (error) {
            setReviewStandardVerification(
                isDeterministicReviewStandardSourceError(error) ||
                    priorVerification !== "verified"
                    ? "blocked"
                    : "verified",
            );
            throw error;
        }
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
        setReviewStandardVerification("not-required");
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
        if (reviewStandardSourceBlocked) {
            setActionError(
                matterDocumentsLoading || reviewStandardVerification === "checking"
                    ? "Vera is confirming the Matter standard before writing to Word."
                    : "Playbook source missing. Vera cannot write this suggestion to Word until the standard has a verifiable Matter citation.",
            );
            return;
        }
        setApplying("tracked");
        setActionError(null);
        try {
            await confirmReviewStandardBeforeWrite();
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
        if (reviewStandardSourceBlocked) {
            setActionError(
                matterDocumentsLoading || reviewStandardVerification === "checking"
                    ? "Vera is confirming the Matter standard before writing to Word."
                    : "Playbook source missing. Vera cannot write this suggestion to Word until the standard has a verifiable Matter citation.",
            );
            return;
        }
        setApplying("comment");
        setActionError(null);
        try {
            await confirmReviewStandardBeforeWrite();
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
    const reviewStandardSourceCitation =
        suggestion?.reviewStandard && activeSuggestion
            ? findReviewStandardCitation(
                  suggestion.citations,
                  suggestion.reviewStandard.documentId,
                  activeSuggestion.standardCitationRef,
              )
            : null;
    const reviewStandardUnavailable =
        !!suggestion?.reviewStandard &&
        (matterDocumentsLoading ||
            !reviewStandardDocuments.some(
                (document) =>
                    document.id === suggestion.reviewStandard?.documentId &&
                    document.status === "ready",
            ));
    const reviewStandardSourceBlocked =
        !!suggestion?.reviewStandard &&
        (!reviewStandardSourceCitation ||
            reviewStandardUnavailable ||
            reviewStandardVerification !== "verified");
    const reviewStandardSourceHref =
        selectedProject &&
        reviewStandardSourceCitation &&
        !reviewStandardUnavailable &&
        reviewStandardVerification === "verified"
            ? citationDocumentHref(selectedProject.id, reviewStandardSourceCitation)
            : null;
    const canWriteToWord =
        host.kind === "word" &&
        host.canReviewInDocument &&
        activeSuggestion?.status === "pending" &&
        !reviewStandardSourceBlocked &&
        !generating &&
        !staleOrAmbiguousSelection &&
        !readOnlyDocument;
    const hasWriteRestrictionMessage =
        activeSuggestion?.status === "pending" &&
        !canWriteToWord &&
        !applied;
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
        : generateError && /playbook source missing/i.test(generateError)
          ? "Playbook source missing"
        : documentLocationError
          ? "Document changed"
          : generateError && /model|provider|api|network|fetch|unavailable|quota|credential/i.test(generateError)
            ? "Model unavailable"
            : "Review could not be generated";
    const writeRestrictionMessage = staleOrAmbiguousSelection
        ? `The ${scope === "selection" ? "selection" : "document"} changed. Refresh it before applying this suggestion.`
        : readOnlyDocument
          ? "This Word document is read-only. You can still copy the suggestion."
          : reviewStandardSourceBlocked
            ? matterDocumentsLoading || reviewStandardVerification === "checking"
              ? "Vera is confirming the Matter standard before enabling Word actions. You can still copy the suggestion."
              : "Copy stays available. Select a Matter standard with a verifiable source before writing to Word."
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
                                                    setMatterDocuments([]);
                                                    setSelectedMatterDocumentId("");
                                                    setSelectedReviewStandardDocumentId("");
                                                    setMatterDocumentVersionBase(null);
                                                    setMatterDocumentError(null);
                                                    setMatterVersionMessage(null);
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

                                {scope === "document" && selectedProject && (
                                    <section
                                        aria-labelledby="review-standard-heading"
                                        className="mt-4 border-t border-gray-200/80 pt-4"
                                    >
                                        <h2
                                            id="review-standard-heading"
                                            className="text-sm font-semibold text-gray-900"
                                        >
                                            Review against
                                        </h2>
                                        <p
                                            id="review-standard-help"
                                            className="mt-1 text-sm leading-5 text-gray-600"
                                        >
                                            Optionally use a Matter DOCX as the drafting standard.
                                        </p>
                                        {matterDocumentsLoading ? (
                                            <div className="mt-2 h-10 animate-pulse rounded-lg bg-gray-100 motion-reduce:animate-none" />
                                        ) : reviewStandardDocuments.length ? (
                                            <select
                                                id="word-review-standard"
                                                aria-label="Review against Matter standard"
                                                aria-describedby="review-standard-help"
                                                value={selectedReviewStandardDocumentId}
                                                disabled={generating || restoringReview}
                                                onChange={(event) => {
                                                    setSelectedReviewStandardDocumentId(
                                                        event.target.value,
                                                    );
                                                    setSuggestion(null);
                                                    setReviewStandardVerification(
                                                        "not-required",
                                                    );
                                                    setActiveSuggestionIndex(0);
                                                    setApplied(null);
                                                    setActionError(null);
                                                    setGenerateError(null);
                                                }}
                                                className="mt-2 min-h-10 w-full truncate rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none transition-colors hover:border-gray-400 focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
                                            >
                                                <option value="">No Matter DOCX standard</option>
                                                {reviewStandardDocuments.map((document) => (
                                                    <option
                                                        key={document.id}
                                                        value={document.id}
                                                    >
                                                        {document.filename}
                                                    </option>
                                                ))}
                                            </select>
                                        ) : (
                                            <p className="mt-2 text-sm leading-5 text-gray-700">
                                                Add a Matter DOCX before using a standard.
                                            </p>
                                        )}
                                    </section>
                                )}

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
                                        {selectedReviewStandardDocument
                                            ? <>Loaded main document text and the Matter standard <span className="break-words font-medium text-gray-800">{selectedReviewStandardDocument.filename}</span> are sent to your configured model when you generate suggestions.</>
                                            : <>{scope === "selection" ? "Selected text" : "Loaded main document text"} is sent to your configured model when you generate suggestions.</>}
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
                                        {suggestion?.reviewStandard && (
                                            <section
                                                aria-label="Review standard"
                                                className="mt-3 border-y border-gray-200 py-3"
                                            >
                                                <p className="text-xs font-medium text-gray-700">
                                                    Review standard
                                                </p>
                                                <p
                                                    title={suggestion.reviewStandard.filename}
                                                    className="mt-1 break-words text-sm font-medium leading-5 text-gray-900"
                                                >
                                                    {suggestion.reviewStandard.filename}
                                                </p>
                                                {activeSuggestion?.standard && (
                                                    <p className="mt-2 text-sm leading-5 text-gray-700">
                                                        <span className="font-medium text-gray-900">
                                                            Standard:
                                                        </span>{" "}
                                                        {activeSuggestion.standard}
                                                    </p>
                                                )}
                                                {activeSuggestion?.deviation && (
                                                    <p className="mt-2 text-sm leading-5 text-gray-700">
                                                        <span className="font-medium text-gray-900">
                                                            Difference:
                                                        </span>{" "}
                                                        {activeSuggestion.deviation}
                                                    </p>
                                                )}
                                                {reviewStandardSourceHref &&
                                                reviewStandardSourceCitation ? (
                                                    <Link
                                                        href={reviewStandardSourceHref}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="mt-2 inline-flex min-h-10 break-words items-center gap-1.5 rounded-lg px-1 text-sm font-medium text-blue-700 outline-none hover:text-blue-900 focus-visible:ring-2 focus-visible:ring-blue-600"
                                                    >
                                                        Open Matter standard source · {citationLabel(reviewStandardSourceCitation)}
                                                        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                                                    </Link>
                                                ) : (
                                                    <p
                                                        role="alert"
                                                        className="mt-2 text-sm leading-5 text-amber-900"
                                                    >
                                                        {matterDocumentsLoading ||
                                                        reviewStandardVerification === "checking"
                                                            ? "Vera is confirming the Matter standard before enabling Word actions."
                                                            : "Playbook source missing. Vera cannot write this suggestion to Word until the standard has a verifiable Matter citation."}
                                                    </p>
                                                )}
                                            </section>
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
                                {suggestion &&
                                    suggestion.citations.length === 0 &&
                                    !suggestion.reviewStandard && (
                                    <div role="status" className="mt-3 rounded-lg bg-amber-50 px-3 py-2.5 text-sm leading-5 text-amber-950">
                                        <p className="font-medium">No Matter source linked</p>
                                        <p className="mt-1">Verify this drafting suggestion against the Word text or the saved Matter chat before applying it.</p>
                                    </div>
                                )}
                                {activeSuggestion && (
                                    <div className="mt-4 space-y-2">
                                        <PillButton aria-describedby={hasWriteRestrictionMessage ? "word-write-restriction" : undefined} tone="black" size="normal" className="min-h-11 w-full" disabled={!canWriteToWord || !!applying} onClick={() => void applySuggestionAsTrackedChange()}>
                                            {applying === "tracked" ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <FilePenLine className="h-4 w-4" />}
                                            Apply as tracked change
                                        </PillButton>
                                        <div className="grid grid-cols-1 gap-2 min-[300px]:grid-cols-2">
                                            <PillButton aria-describedby={hasWriteRestrictionMessage ? "word-write-restriction" : undefined} tone="white" size="normal" className="min-h-11 w-full" disabled={!canWriteToWord || !!applying} onClick={() => void addSuggestionComment()}>
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
                                {hasWriteRestrictionMessage && (
                                    <p id="word-write-restriction" className="mt-3 text-sm leading-5 text-amber-900">
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
                                <div className="mt-6 border-t border-gray-200/80 pt-6">
                                    <h3 className="text-sm font-semibold text-gray-900">
                                        Save to Matter
                                    </h3>
                                    <p className="mt-1 text-sm leading-5 text-gray-600">
                                        Save the current Word file as a new version. Existing versions remain available.
                                    </p>
                                    {selectedProject ? (
                                        <div className="mt-3">
                                            <p className="truncate text-xs font-medium text-gray-600">
                                                {selectedProject.name}
                                            </p>
                                            <label
                                                htmlFor="word-matter-document"
                                                className="mt-3 block text-sm font-medium text-gray-900"
                                            >
                                                Target document
                                            </label>
                                            {matterDocumentsLoading ? (
                                                <div className="mt-2 h-10 animate-pulse rounded-lg bg-gray-100 motion-reduce:animate-none" />
                                            ) : matterDocuments.length > 0 ? (
                                                <select
                                                    id="word-matter-document"
                                                    value={selectedMatterDocumentId}
                                                    disabled={
                                                        generating ||
                                                        restoringReview ||
                                                        matterVersionLoading ||
                                                        matterVersionSaving
                                                    }
                                                    onChange={(event) =>
                                                        void selectMatterDocumentTarget(
                                                            event.target.value,
                                                        )
                                                    }
                                                    className="mt-2 min-h-10 w-full truncate rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none transition-colors hover:border-gray-400 focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
                                                >
                                                    <option value="">
                                                        Choose a Word document…
                                                    </option>
                                                    {matterDocuments.map(
                                                        (document) => (
                                                            <option
                                                                key={document.id}
                                                                value={document.id}
                                                            >
                                                                {document.filename}
                                                            </option>
                                                        ),
                                                    )}
                                                </select>
                                            ) : (
                                                <p className="mt-2 text-sm leading-5 text-gray-700">
                                                    This Matter has no Word document to version. Add the source document in Vera first.
                                                </p>
                                            )}
                                            {matterVersionLoading && (
                                                <p role="status" className="mt-2 text-xs leading-5 text-gray-600">
                                                    Checking the current Matter version…
                                                </p>
                                            )}
                                            {selectedMatterDocument &&
                                                matterDocumentVersionBase &&
                                                !matterVersionLoading && (
                                                    <>
                                                    <p className="mt-2 text-xs leading-5 text-gray-600">
                                                        Current Matter version: {matterDocumentVersionBase.versionNumber ? `V${matterDocumentVersionBase.versionNumber}` : "version available"}
                                                    </p>
                                                    <PillButton
                                                        tone="black"
                                                        size="normal"
                                                        className="mt-3 min-h-11 w-full whitespace-normal px-3 py-2 leading-5"
                                                        title={`Save ${selectedMatterDocument.filename} as ${matterDocumentVersionBase.versionNumber !== null ? `V${matterDocumentVersionBase.versionNumber + 1}` : "a new version"}`}
                                                        disabled={
                                                            host.kind !== "word" ||
                                                            matterVersionSaving ||
                                                            generating ||
                                                            restoringReview ||
                                                            taskArtifactSaveBlocked
                                                        }
                                                        onClick={() =>
                                                            void saveWordDocumentVersion()
                                                        }
                                                    >
                                                        {matterVersionSaving ? (
                                                            <Loader2 className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" />
                                                        ) : (
                                                            <Save className="h-4 w-4 shrink-0" />
                                                        )}
                                                        <span className="min-w-0 break-words text-center">
                                                            {matterVersionSaving
                                                                ? `Saving ${selectedMatterDocument.filename}…`
                                                                : `Save ${selectedMatterDocument.filename} as ${matterDocumentVersionBase.versionNumber !== null ? `V${matterDocumentVersionBase.versionNumber + 1}` : "a new version"}`}
                                                        </span>
                                                    </PillButton>
                                                    {host.kind !== "word" && (
                                                        <p className="mt-2 text-xs leading-5 text-gray-600">
                                                            Open this task pane in Word to save the current document.
                                                        </p>
                                                    )}
                                                    </>
                                            )}
                                        </div>
                                    ) : (
                                        <p className="mt-3 text-sm leading-5 text-gray-700">
                                            Choose a Matter in Assistant first.
                                        </p>
                                    )}
                                    {matterDocumentError && (
                                        <div role="alert" className="mt-3 text-sm leading-5 text-red-700">
                                            <p>{matterDocumentError}</p>
                                            {selectedMatterDocumentId && (
                                                <button
                                                    type="button"
                                                    disabled={matterVersionLoading || matterVersionSaving}
                                                    onClick={() =>
                                                        void selectMatterDocumentTarget(
                                                            selectedMatterDocumentId,
                                                        )
                                                    }
                                                    className="mt-1 min-h-10 rounded-lg px-1 font-medium underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                                                >
                                                    Refresh target version
                                                </button>
                                            )}
                                        </div>
                                    )}
                                    {matterVersionMessage && (
                                        <p role="status" className="mt-3 text-sm leading-5 text-emerald-800">
                                            {matterVersionMessage}
                                        </p>
                                    )}
                                </div>
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
