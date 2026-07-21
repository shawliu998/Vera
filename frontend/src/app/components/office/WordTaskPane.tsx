"use client";

import Script from "next/script";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
    AlertCircle,
    Check,
    Copy,
    ExternalLink,
    FilePenLine,
    Loader2,
    MessageSquarePlus,
    RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SiteLogo } from "@/app/components/site-logo";
import { PillButton } from "@/app/components/ui/pill-button";
import type { Citation, Project } from "@/app/components/shared/types";
import { listProjects, streamProjectChat } from "@/app/lib/mikeApi";
import { useSelectedModel } from "@/app/hooks/useSelectedModel";
import {
    applyTrackedReplacement,
    detectWordHost,
    insertSuggestionComment,
    readCurrentWordSelection,
    type WordHostState,
} from "@/app/lib/wordOfficeBridge";
import {
    buildWordSuggestionPrompt,
    readWordSuggestionStream,
    type WordReviewMode,
} from "@/app/lib/wordSuggestion";

const INITIAL_HOST: WordHostState = {
    kind: "loading",
    platform: null,
    canReadSelection: false,
    canReviewInDocument: false,
    message: "Connecting to Word…",
};

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

type SuggestionState = {
    original: string;
    text: string;
    instruction: string;
    citations: Citation[];
    chatId: string | null;
};

type AppliedState =
    | { kind: "tracked"; message: string }
    | { kind: "comment"; message: string }
    | null;

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

export function WordTaskPane() {
    const searchParams = useSearchParams();
    const previewMode = searchParams.get("preview");
    const isPreview = previewMode === "ready" || previewMode === "empty";
    const previewContent = searchParams.get("lang") === "zh"
        ? CHINESE_PREVIEW
        : ENGLISH_PREVIEW;
    const [model] = useSelectedModel();
    const [officeScriptReady, setOfficeScriptReady] = useState(false);
    const [host, setHost] = useState<WordHostState>(INITIAL_HOST);
    const [projects, setProjects] = useState<Project[]>([]);
    const [projectsLoading, setProjectsLoading] = useState(true);
    const [projectError, setProjectError] = useState<string | null>(null);
    const [selectedProjectId, setSelectedProjectId] = useState("");
    const [selection, setSelection] = useState("");
    const [selectionLoading, setSelectionLoading] = useState(false);
    const [selectionError, setSelectionError] = useState<string | null>(null);
    const [mode, setMode] = useState<WordReviewMode>("review");
    const [instruction, setInstruction] = useState("");
    const [suggestion, setSuggestion] = useState<SuggestionState | null>(null);
    const [streamingText, setStreamingText] = useState("");
    const [generating, setGenerating] = useState(false);
    const [generateError, setGenerateError] = useState<string | null>(null);
    const [applying, setApplying] = useState<"tracked" | "comment" | null>(null);
    const [applied, setApplied] = useState<AppliedState>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const abortRef = useRef<AbortController | null>(null);

    const selectedProject = useMemo(
        () => projects.find((project) => project.id === selectedProjectId) ?? null,
        [projects, selectedProjectId],
    );

    const loadSelection = useCallback(async () => {
        if (host.kind !== "word" || !host.canReadSelection) return;
        setSelectionLoading(true);
        setSelectionError(null);
        setActionError(null);
        try {
            const value = await readCurrentWordSelection();
            setSelection(value.trim());
            setSuggestion(null);
            setApplied(null);
            if (!value.trim()) {
                setSelectionError("Select the text you want Vera to review in Word.");
            }
        } catch (error) {
            setSelectionError(readableError(error));
        } finally {
            setSelectionLoading(false);
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
            void loadSelection();
        }
    }, [host.kind, host.canReadSelection, loadSelection]);

    useEffect(() => {
        if (isPreview) {
            setProjects(PREVIEW_PROJECTS);
            setSelectedProjectId(PREVIEW_PROJECTS[0].id);
            setSelection(previewContent.selection);
            setInstruction(previewContent.instruction);
            if (previewMode === "ready") {
                setSuggestion({
                    original: previewContent.selection,
                    text: previewContent.suggestion,
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
                });
            }
            setProjectsLoading(false);
            return;
        }

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
                        : (loaded[0]?.id ?? ""),
                );
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
    }, [isPreview, previewContent, previewMode]);

    useEffect(
        () => () => {
            abortRef.current?.abort();
        },
        [],
    );

    async function generateSuggestion() {
        if (!selectedProjectId || !selection.trim() || !instruction.trim()) return;
        setGenerating(true);
        setGenerateError(null);
        setActionError(null);
        setApplied(null);
        setStreamingText("");
        setSuggestion(null);

        if (isPreview) {
            await new Promise((resolve) => window.setTimeout(resolve, 300));
            setSuggestion({
                original: selection,
                text: previewContent.suggestion,
                instruction: instruction.trim(),
                chatId: "preview-chat",
                citations: [],
            });
            setGenerating(false);
            return;
        }

        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const prompt = buildWordSuggestionPrompt({
                mode,
                selection,
                instruction,
            });
            const response = await streamProjectChat({
                projectId: selectedProjectId,
                messages: [{ role: "user", content: prompt }],
                model,
                signal: controller.signal,
            });
            const result = await readWordSuggestionStream(response, setStreamingText);
            setSuggestion({
                original: selection,
                text: result.text,
                instruction: instruction.trim(),
                citations: result.citations,
                chatId: result.chatId,
            });
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                setGenerateError("Suggestion generation was cancelled.");
            } else {
                setGenerateError(readableError(error));
            }
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
            setGenerating(false);
            setStreamingText("");
        }
    }

    function cancelGeneration() {
        abortRef.current?.abort();
    }

    async function applySuggestionAsTrackedChange() {
        if (!suggestion || applying) return;
        setApplying("tracked");
        setActionError(null);
        try {
            const result = await applyTrackedReplacement({
                expectedSelection: suggestion.original,
                replacement: suggestion.text,
            });
            setApplied({
                kind: "tracked",
                message: result.trackingRestored
                    ? "Inserted as a tracked change. Review it in Word; Vera did not accept it."
                    : "Inserted as a tracked change. Word kept change tracking enabled; review the document setting before continuing.",
            });
        } catch (error) {
            setActionError(readableError(error));
        } finally {
            setApplying(null);
        }
    }

    async function addSuggestionComment() {
        if (!suggestion || applying) return;
        setApplying("comment");
        setActionError(null);
        try {
            await insertSuggestionComment({
                expectedSelection: suggestion.original,
                comment: `Vera suggestion:\n${suggestion.text}\n\nInstruction: ${suggestion.instruction}`,
            });
            setApplied({
                kind: "comment",
                message: "Added a comment to the selected text. The document text was not changed.",
            });
        } catch (error) {
            setActionError(readableError(error));
        } finally {
            setApplying(null);
        }
    }

    async function copySuggestion() {
        if (!suggestion) return;
        try {
            await navigator.clipboard.writeText(suggestion.text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1800);
        } catch {
            setActionError("Vera could not copy the suggestion. Select the text and copy it manually.");
        }
    }

    const canGenerate =
        !!selectedProjectId &&
        !!selection.trim() &&
        !!instruction.trim() &&
        !generating;
    const canWriteToWord =
        host.kind === "word" && host.canReviewInDocument && !applied;

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
                                    ? "Word connected"
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

                    <main className="flex flex-1 flex-col px-3 py-5 min-[360px]:px-4">
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
                                        onChange={(event) => {
                                            setSelectedProjectId(event.target.value);
                                            setSuggestion(null);
                                            setApplied(null);
                                        }}
                                        className="min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none transition-colors hover:border-gray-400 focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600/20"
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

                        <section aria-labelledby="selection-heading" className="mt-6 border-t border-gray-200/80 pt-6">
                            <div className="flex items-center gap-2">
                                <h2 id="selection-heading" className="text-sm font-semibold text-gray-900">
                                    Word selection
                                </h2>
                                <button
                                    type="button"
                                    onClick={() => void loadSelection()}
                                    disabled={host.kind !== "word" || selectionLoading}
                                    className="ml-auto inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-gray-600 outline-none transition-colors hover:bg-gray-100 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-blue-600/30 disabled:cursor-not-allowed disabled:opacity-45"
                                >
                                    <RefreshCw className={`h-3.5 w-3.5 ${selectionLoading ? "animate-spin motion-reduce:animate-none" : ""}`} />
                                    Refresh
                                </button>
                            </div>
                            <div className="mt-2 max-h-36 overflow-y-auto rounded-lg bg-gray-100 px-3 py-3 font-serif text-base leading-relaxed text-gray-900 [line-break:strict] [overflow-wrap:anywhere]">
                                {selection || "Select text in Word, then refresh the selection."}
                            </div>
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
                            <div
                                role="group"
                                aria-label="Suggestion type"
                                className="mt-2 flex rounded-lg bg-gray-100 p-1"
                            >
                                {(["review", "rewrite"] as const).map((value) => (
                                    <button
                                        key={value}
                                        type="button"
                                        aria-pressed={mode === value}
                                        onClick={() => setMode(value)}
                                        className={`min-h-9 flex-1 rounded-md px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-600/30 ${mode === value ? "bg-white text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900"}`}
                                    >
                                        {value === "review" ? "Review" : "Rewrite"}
                                    </button>
                                ))}
                            </div>
                            <label htmlFor="word-review-instruction" className="sr-only">
                                Review or rewrite instruction
                            </label>
                            <textarea
                                id="word-review-instruction"
                                value={instruction}
                                onChange={(event) => {
                                    setInstruction(event.target.value);
                                    setApplied(null);
                                }}
                                rows={4}
                                placeholder={
                                    mode === "review"
                                        ? "Describe the risk to address or the outcome you need."
                                        : "Describe how the selected text should be rewritten."
                                }
                                className="mt-2 w-full resize-y rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base leading-relaxed text-gray-900 outline-none placeholder:text-gray-600 hover:border-gray-400 focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600/20"
                            />
                            <div className="mt-3 flex flex-wrap gap-2">
                                <PillButton
                                    tone="black"
                                    size="normal"
                                    className="min-h-10 flex-1"
                                    disabled={!canGenerate}
                                    onClick={() => void generateSuggestion()}
                                >
                                    {generating && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
                                    {generating ? "Generating suggestion" : "Generate suggestion"}
                                </PillButton>
                                {generating && (
                                    <PillButton
                                        tone="white"
                                        size="normal"
                                        className="min-h-10 flex-1"
                                        onClick={cancelGeneration}
                                    >
                                        Cancel
                                    </PillButton>
                                )}
                            </div>
                            <p className="mt-2 text-xs leading-relaxed text-gray-600">
                                Selected text is sent to your configured model when you generate a suggestion.
                            </p>
                            {generateError && (
                                <p role="alert" className="mt-2 text-sm leading-5 text-red-700">
                                    {generateError}
                                </p>
                            )}
                        </section>

                        {(suggestion || streamingText) && (
                            <section aria-labelledby="suggestion-heading" className="mt-6 border-t border-gray-200/80 pt-6">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h2 id="suggestion-heading" className="text-lg font-semibold leading-6 text-gray-900">
                                        Suggestion
                                    </h2>
                                    <span className="ml-auto rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">
                                        Pending review
                                    </span>
                                </div>

                                <div className="mt-3 rounded-xl bg-gray-100 p-3">
                                    {suggestion && (
                                        <>
                                            <p className="text-xs font-medium text-gray-700">Selected text</p>
                                            <del className="mt-1 block font-serif text-base leading-relaxed text-red-700 decoration-red-700 [line-break:strict] [overflow-wrap:anywhere]">
                                                {suggestion.original}
                                            </del>
                                            <div className="my-3 h-px bg-gray-300" />
                                        </>
                                    )}
                                    <p className="text-xs font-medium text-gray-700">Proposed replacement</p>
                                    <ins className="mt-1 block text-pretty font-serif text-base leading-relaxed text-green-800 no-underline [line-break:strict] [overflow-wrap:anywhere]">
                                        {suggestion?.text || streamingText}
                                    </ins>
                                </div>

                                {suggestion?.citations.length ? (
                                    <div className="mt-3">
                                        <p className="text-xs font-medium text-gray-700">
                                            Sources used
                                        </p>
                                        <ul className="mt-1.5 space-y-1 text-sm leading-5 text-gray-700">
                                            {suggestion.citations.slice(0, 3).map((citation, index) => (
                                                <li key={`${citation.ref}-${index}`} className="break-words">
                                                    {citationLabel(citation)}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                ) : null}

                                {suggestion && (
                                    <div className="mt-4 space-y-2">
                                        <PillButton
                                            tone="black"
                                            size="normal"
                                            className="min-h-10 w-full"
                                            disabled={!canWriteToWord || !!applying}
                                            onClick={() => void applySuggestionAsTrackedChange()}
                                        >
                                            {applying === "tracked" ? (
                                                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                                            ) : (
                                                <FilePenLine className="h-4 w-4" />
                                            )}
                                            Apply as tracked change
                                        </PillButton>
                                        <PillButton
                                            tone="white"
                                            size="normal"
                                            className="min-h-10 w-full"
                                            disabled={!canWriteToWord || !!applying}
                                            onClick={() => void addSuggestionComment()}
                                        >
                                            {applying === "comment" ? (
                                                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                                            ) : (
                                                <MessageSquarePlus className="h-4 w-4" />
                                            )}
                                            Insert comment
                                        </PillButton>
                                        <button
                                            type="button"
                                            onClick={() => void copySuggestion()}
                                            className="inline-flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium text-gray-700 outline-none transition-colors hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-600/30"
                                        >
                                            {copied ? <Check className="h-4 w-4 text-emerald-700" /> : <Copy className="h-4 w-4" />}
                                            {copied ? "Copied" : "Copy suggestion"}
                                        </button>
                                    </div>
                                )}

                                {suggestion && !canWriteToWord && !applied && (
                                    <p className="mt-3 text-sm leading-5 text-amber-900">
                                        Open this task pane in a Word host with WordApi 1.4 to insert a comment or tracked replacement. You can still copy the suggestion.
                                    </p>
                                )}
                                {applied && (
                                    <div role="status" className="mt-3 flex gap-2 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm leading-5 text-emerald-900">
                                        <Check className="mt-0.5 h-4 w-4 shrink-0" />
                                        <span>{applied.message}</span>
                                    </div>
                                )}
                                {actionError && (
                                    <p role="alert" className="mt-3 text-sm leading-5 text-red-700">
                                        {actionError}
                                    </p>
                                )}

                                {suggestion?.chatId && selectedProject && !isPreview && (
                                    <Link
                                        href={`/projects/${selectedProject.id}/assistant/chat/${suggestion.chatId}`}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="mt-3 inline-flex min-h-10 items-center gap-1.5 rounded-lg text-sm font-medium text-blue-700 outline-none hover:text-blue-900 focus-visible:ring-2 focus-visible:ring-blue-600/30"
                                    >
                                        Open saved Matter chat
                                        <ExternalLink className="h-3.5 w-3.5" />
                                    </Link>
                                )}

                                <p className="mt-3 text-xs leading-relaxed text-gray-600">
                                    Vera does not accept Word changes automatically.
                                </p>
                            </section>
                        )}

                        {!projectsLoading && projects.length === 0 && (
                            <Link
                                href="/projects"
                                target="_blank"
                                className="mt-6 inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg bg-gray-950 px-4 text-sm font-medium text-white outline-none hover:bg-gray-900 focus-visible:ring-2 focus-visible:ring-blue-600/40"
                            >
                                Open Matters in Vera
                                <ExternalLink className="h-3.5 w-3.5" />
                            </Link>
                        )}
                    </main>
                </div>
            </div>
        </>
    );
}
