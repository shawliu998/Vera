"use client";

import {
    type CSSProperties,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
    useEffect,
    useRef,
    useState,
} from "react";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    Check,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    Loader2,
    PanelLeft,
    RefreshCw,
    X,
} from "lucide-react";
import type {
    ColumnConfig,
    Document,
    TabularCell,
    TabularRecordCitation,
} from "../shared/types";
import { isSpreadsheetFilename } from "../shared/types";
import { preprocessCitations, type ParsedCitation } from "./citation-utils";
import { getPillClass } from "./pillUtils";
import { PdfView } from "../shared/views/PdfView";
import { SpreadsheetView } from "../shared/views/SpreadsheetView";
import { DocxView } from "../shared/views/DocxView";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import { CitationQuotesHeader } from "../assistant/CitationQuotesHeader";
import { cn } from "@/app/lib/utils";
import {
    APP_SURFACE_HOVER_CLASS,
    APP_SURFACE_PRESSED_CLASS,
    LIQUID_PANEL_SURFACE_CLASS,
} from "@/app/components/ui/liquid-surface";
import {
    canRequestSourceBoundCorrection,
    DEFAULT_SOURCE_BOUND_CORRECTION_REASON,
    SOURCE_BOUND_CORRECTION_REASONS,
    type SourceBoundCorrectionReasonCode,
} from "./litigationEvidenceInventoryUi";

function isDocxDocument(d: {
    file_type?: string | null;
    filename?: string;
}): boolean {
    const ft = (d.file_type ?? "").toLowerCase();
    if (ft === "docx" || ft === "doc") return true;
    const ext = d.filename?.split(".").pop()?.toLowerCase();
    return ext === "docx" || ext === "doc";
}

interface Props {
    cell: TabularCell;
    document: Document;
    documents: Document[];
    /** All Review Documents, used to resolve a citation's fixed document id. */
    sourceDocuments?: Document[];
    column: ColumnConfig;
    columns: ColumnConfig[];
    onClose: () => void;
    onNavigate: (documentId: string, columnIndex: number) => void;
    onRegenerate?: () => Promise<void>;
    /** If true, open the document panel immediately */
    displayDocument?: boolean;
    /** Quote to highlight when opening document panel */
    citationQuote?: string;
    /** Page to scroll to when opening document panel */
    citationPage?: number;
    /** Spreadsheet worksheet containing the cited cell */
    citationSheet?: string;
    /** Spreadsheet A1 cell address or range */
    citationCell?: string;
    /** One-based citation number shown in the cell content */
    citationRef?: number;
    /** Task-owned Evidence Inventory controls; absent for an ordinary review. */
    litigationEvidence?: {
        stageLabel: string;
        representedSideLabel: string;
        citations: TabularRecordCitation[];
        reviewStatus?: "verified" | "unresolved" | "needs_correction" | null;
        reviewActive: boolean;
        saving: boolean;
        error: string | null;
        onReview: (decision: "verified" | "unresolved") => Promise<void>;
        onRequestSourceBoundCorrection: (
            reasonCode: SourceBoundCorrectionReasonCode,
        ) => Promise<void>;
    };
}

type TRPanelCitation = {
    quote: string;
    page?: number;
    sheet?: string;
    cell?: string;
    citationRef?: number;
    documentId?: string;
    versionId?: string;
    locatorLabel?: string;
};

const FLAG_BADGE: Record<string, string> = {
    green: "bg-emerald-600 backdrop-blur-md border border-emerald-300/20 text-white shadow-md",
    grey: "bg-slate-500 backdrop-blur-md border border-slate-300/20 text-white shadow-md",
    yellow: "bg-amber-500 backdrop-blur-md border border-amber-300/20 text-white shadow-md",
    red: "bg-red-600 backdrop-blur-md border border-red-300/20 text-white shadow-md",
};

const MIN_DOCUMENT_PANE_WIDTH = 420;
const DEFAULT_DOCUMENT_PANE_WIDTH = 600;
const MAX_DOCUMENT_PANE_WIDTH = 1000;
const INFO_PANE_WIDTH = 300;

// ---------------------------------------------------------------------------
// TRSidePanel
// ---------------------------------------------------------------------------

export function TRSidePanel({
    cell,
    document: doc,
    documents,
    sourceDocuments,
    column,
    columns,
    onClose,
    onNavigate,
    onRegenerate,
    displayDocument = false,
    citationQuote,
    citationPage,
    citationSheet,
    citationCell,
    citationRef,
    litigationEvidence,
}: Props) {
    const sortedColumns = [...columns].sort((a, b) => a.index - b.index);
    const currentPos = sortedColumns.findIndex((c) => c.index === column.index);
    const previousColumn =
        currentPos > 0 ? sortedColumns[currentPos - 1] : null;
    const nextColumn =
        currentPos >= 0 && currentPos < sortedColumns.length - 1
            ? sortedColumns[currentPos + 1]
            : null;
    const currentDocumentPos = documents.findIndex(
        (candidate) => candidate.id === doc.id,
    );
    const previousDocument =
        currentDocumentPos > 0 ? documents[currentDocumentPos - 1] : null;
    const nextDocument =
        currentDocumentPos >= 0 && currentDocumentPos < documents.length - 1
            ? documents[currentDocumentPos + 1]
            : null;
    const [regenerating, setRegenerating] = useState(false);
    const [sourceBoundCorrectionReason, setSourceBoundCorrectionReason] =
        useState<SourceBoundCorrectionReasonCode>(
            DEFAULT_SOURCE_BOUND_CORRECTION_REASON,
        );
    const [documentPaneOpen, setDocumentPaneOpen] = useState(displayDocument);
    const [documentPaneWidth, setDocumentPaneWidth] = useState(
        DEFAULT_DOCUMENT_PANE_WIDTH,
    );
    const panelRef = useRef<HTMLDivElement>(null);
    const resizePointerId = useRef<number | null>(null);
    const resizeStartX = useRef(0);
    const resizeStartWidth = useRef(DEFAULT_DOCUMENT_PANE_WIDTH);

    // Internal state — initialised from props, also toggled by badge clicks inside the panel
    const [docCitation, setDocCitation] = useState<TRPanelCitation | undefined>(
        displayDocument && citationQuote
            ? {
                  quote: citationQuote,
                  page: citationPage,
                  sheet: citationSheet,
                  cell: citationCell,
                  citationRef,
              }
            : undefined,
    );
    const documentForView = docCitation?.documentId
        ? (sourceDocuments ?? documents).find(
              (candidate) => candidate.id === docCitation.documentId,
          )
        : doc;

    useEffect(() => {
        setSourceBoundCorrectionReason(
            DEFAULT_SOURCE_BOUND_CORRECTION_REASON,
        );
    }, [cell.id]);

    const canRequestCorrection =
        litigationEvidence &&
        canRequestSourceBoundCorrection({
            taskWaitingForReview: litigationEvidence.reviewActive,
            cellStatus: cell.status,
            reviewStatus: litigationEvidence.reviewStatus,
            reviewRevision: cell.review_revision,
        });

    // Re-sync when the panel opens for a different cell or citation
    useEffect(() => {
        setDocCitation(
            displayDocument && citationQuote
                ? {
                      quote: citationQuote,
                      page: citationPage,
                      sheet: citationSheet,
                      cell: citationCell,
                      citationRef,
                  }
                : undefined,
        );
        setDocumentPaneOpen(displayDocument);
    }, [
        cell.id,
        displayDocument,
        citationCell,
        citationPage,
        citationQuote,
        citationRef,
        citationSheet,
    ]);

    useEffect(
        () => () => {
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        },
        [],
    );

    useEffect(() => {
        const handleOutsidePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (
                !(target instanceof Node) ||
                panelRef.current?.contains(target)
            ) {
                return;
            }
            onClose();
        };

        document.addEventListener("pointerdown", handleOutsidePointerDown);
        return () =>
            document.removeEventListener(
                "pointerdown",
                handleOutsidePointerDown,
            );
    }, [onClose]);

    function handleDocumentResizePointerDown(
        event: ReactPointerEvent<HTMLDivElement>,
    ) {
        event.preventDefault();
        resizePointerId.current = event.pointerId;
        resizeStartX.current = event.clientX;
        resizeStartWidth.current = documentPaneWidth;
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    }

    function handleDocumentResizePointerMove(
        event: ReactPointerEvent<HTMLDivElement>,
    ) {
        if (resizePointerId.current !== event.pointerId) return;

        const viewportMax = window.innerWidth - INFO_PANE_WIDTH - 2 * 12 - 24;
        const maxWidth = Math.max(
            MIN_DOCUMENT_PANE_WIDTH,
            Math.min(MAX_DOCUMENT_PANE_WIDTH, viewportMax),
        );
        const nextWidth =
            resizeStartWidth.current + (resizeStartX.current - event.clientX);

        setDocumentPaneWidth(
            Math.min(maxWidth, Math.max(MIN_DOCUMENT_PANE_WIDTH, nextWidth)),
        );
    }

    function handleDocumentResizePointerEnd(
        event: ReactPointerEvent<HTMLDivElement>,
    ) {
        if (resizePointerId.current !== event.pointerId) return;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        resizePointerId.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
    }

    function handleCitationOpen(citation: TRPanelCitation) {
        setDocCitation(citation);
        setDocumentPaneOpen(true);
    }

    function handleStructuredCitationOpen(
        citation: TabularRecordCitation,
        citationIndex: number,
    ) {
        const parsedPage =
            citation.locator.kind === "page" &&
            /^\d+$/.test(citation.locator.value)
                ? Number(citation.locator.value)
                : undefined;
        handleCitationOpen({
            quote: citation.quote,
            page: parsedPage,
            citationRef: citationIndex + 1,
            documentId: citation.document_id,
            versionId: citation.version_id,
            locatorLabel: `${citation.locator.kind}: ${citation.locator.value}`,
        });
    }

    const { processed: summaryText, citations: summaryCitations } =
        preprocessCitations(cell.content?.summary ?? "");
    const { processed: reasoningText, citations: reasoningCitations } =
        preprocessCitations(cell.content?.reasoning ?? "");

    return (
        <div
            ref={panelRef}
            className={cn(
                "fixed z-100 flex flex-col md:flex-row",
                LIQUID_PANEL_SURFACE_CLASS,
                "inset-x-3 top-3 bottom-3 max-w-[calc(100vw-1.5rem)] overflow-hidden md:left-auto",
            )}
        >
            {/* Resizable document panel — left */}
            {documentPaneOpen && documentForView && (
                <div
                    className="relative flex min-h-0 w-full flex-1 shrink flex-col border-b border-white/30 px-3 pb-3 md:w-[min(var(--document-pane-width),calc(100vw-324px))] md:flex-none md:shrink-0 md:border-b-0 md:border-r"
                    style={
                        {
                            "--document-pane-width": `${documentPaneWidth}px`,
                        } as CSSProperties
                    }
                >
                    <div
                        onPointerDown={handleDocumentResizePointerDown}
                        onPointerMove={handleDocumentResizePointerMove}
                        onPointerUp={handleDocumentResizePointerEnd}
                        onPointerCancel={handleDocumentResizePointerEnd}
                        className="absolute inset-y-0 left-0 z-20 hidden w-1.5 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-blue-400/60 md:block"
                        title="Resize document pane"
                    />
                    {/* Doc header */}
                    <div className="flex min-h-11 shrink-0 items-center gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                            <FileTypeIcon
                                fileType={
                                    documentForView.file_type ??
                                    documentForView.filename
                                }
                                className="h-4 w-4"
                            />
                            <div
                                className="min-w-0 truncate text-sm font-medium text-gray-700"
                                title={documentForView.filename}
                            >
                                {documentForView.filename}
                            </div>
                        </div>
                    </div>
                    {/* Quote row */}
                    {docCitation?.quote && (
                        <div className="-mx-3 shrink-0 py-2">
                            <CitationQuotesHeader
                                quotes={[
                                    {
                                        id: citationKey(cell.id, docCitation),
                                        quote: docCitation.quote,
                                        inlineDetail:
                                            formatCitationLocation(docCitation),
                                        citationText: `${documentForView.filename}, ${formatCitationLocation(docCitation)}`,
                                    },
                                ]}
                                activeQuoteId={citationKey(
                                    cell.id,
                                    docCitation,
                                )}
                                citationRef={docCitation.citationRef}
                                citationText={`${documentForView.filename}, ${formatCitationLocation(docCitation)}`}
                            />
                        </div>
                    )}
                    {isDocxDocument(documentForView) &&
                    !documentForView.pdf_storage_path ? (
                        <DocxView
                            documentId={documentForView.id}
                            versionId={docCitation?.versionId}
                            quotes={
                                docCitation
                                    ? [
                                          {
                                              page: docCitation.page,
                                              quote: docCitation.quote,
                                          },
                                      ]
                                    : undefined
                            }
                        />
                    ) : isSpreadsheetFilename(documentForView.filename ?? "") ? (
                        <SpreadsheetView
                            documentId={documentForView.id}
                            versionId={docCitation?.versionId}
                            highlightCells={
                                docCitation?.sheet || docCitation?.cell
                                    ? [
                                          {
                                              sheet: docCitation.sheet,
                                              cell: docCitation.cell,
                                          },
                                      ]
                                    : undefined
                            }
                        />
                    ) : (
                        <PdfView
                            doc={{
                                document_id: documentForView.id,
                                version_id: docCitation?.versionId,
                            }}
                            quote={docCitation?.quote}
                            fallbackPage={docCitation?.page}
                        />
                    )}
                </div>
            )}
            {documentPaneOpen && !documentForView && (
                <div
                    role="alert"
                    className="flex min-h-0 flex-1 items-center p-5 text-xs leading-5 text-amber-900"
                >
                    The fixed source for this citation is unavailable in this
                    Review.
                </div>
            )}

            {/* Info column — right, 300px fixed */}
            <div
                className={cn(
                    "flex min-h-0 w-full shrink-0 flex-col overflow-hidden md:w-[300px]",
                    documentPaneOpen
                        ? "max-h-[42%] md:max-h-none"
                        : "h-full flex-1 md:h-auto md:flex-none",
                )}
            >
                {/* Header */}
                <div className="mb-2 flex min-h-11 shrink-0 items-center justify-end gap-1.5 border-b border-white/30 px-3">
                    <button
                        type="button"
                        onClick={() => setDocumentPaneOpen((open) => !open)}
                        className={cn(
                            "mr-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-white/75 hover:text-gray-700",
                            documentPaneOpen && "bg-white/55 text-gray-700",
                        )}
                        aria-label={
                            documentPaneOpen
                                ? "Collapse document pane"
                                : "Expand document pane"
                        }
                        title={
                            documentPaneOpen
                                ? "Collapse document pane"
                                : "Expand document pane"
                        }
                        aria-pressed={documentPaneOpen}
                    >
                        <PanelLeft className="h-4 w-4" />
                    </button>
                    {onRegenerate && (
                        <button
                            onClick={async () => {
                                setRegenerating(true);
                                try {
                                    await onRegenerate();
                                } finally {
                                    setRegenerating(false);
                                }
                            }}
                            disabled={regenerating}
                            title="Regenerate"
                            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40"
                        >
                            {regenerating ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <RefreshCw className="h-4 w-4" />
                            )}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onClose}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/70 bg-white/55 text-gray-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.75),inset_0_-1px_0_rgba(255,255,255,0.55),0_6px_18px_rgba(15,23,42,0.08)] backdrop-blur-xl transition-colors hover:bg-white/75 hover:text-gray-700"
                        aria-label="Close"
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>

                {/* Analysis panel */}
                <div className="flex-1 overflow-y-auto">
                    <div className="pb-2 px-5">
                        {/* Document field */}
                        <div className="mb-4">
                            <div className="mb-3 text-xs font-medium text-gray-900">
                                Document
                            </div>
                            <div className="flex min-h-6 items-center gap-1.5">
                                <FileTypeIcon
                                    fileType={doc.file_type ?? doc.filename}
                                    className="h-3 w-3"
                                />
                                <div
                                    className="min-w-0 flex-1 truncate text-xs leading-6 text-gray-800"
                                    title={doc.filename}
                                >
                                    {doc.filename}
                                </div>
                            </div>
                        </div>

                        {litigationEvidence && (
                            <section className="mb-5 border-y border-gray-900/[0.07] py-3">
                                <p className="text-[11px] font-medium text-gray-900">
                                    {litigationEvidence.stageLabel} · {" "}
                                    {litigationEvidence.representedSideLabel}
                                </p>
                                <p className="mt-1 text-[11px] leading-4 text-gray-600">
                                    AI draft. Verify the exact quoted source
                                    before relying on this finding.
                                </p>
                            </section>
                        )}

                        {/* Column field */}
                        <div className="mb-4">
                            <div className="mb-3 text-xs font-medium text-gray-900">
                                Column
                            </div>
                            <div className="min-h-6 truncate text-xs leading-6 text-gray-800">
                                {column.name}
                            </div>
                        </div>

                        {/* Flag section */}
                        {!litigationEvidence && cell.content?.flag && (
                            <div className="mb-5">
                                <h4 className="mb-2 text-xs font-medium text-gray-900">
                                    Flag
                                </h4>
                                <span
                                    className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${FLAG_BADGE[cell.content.flag] ?? FLAG_BADGE.grey}`}
                                >
                                    {cell.content.flag.charAt(0).toUpperCase() +
                                        cell.content.flag.slice(1)}
                                </span>
                            </div>
                        )}

                        {/* Results */}
                        <div className="mb-6">
                            <h4 className="mb-2 text-xs font-medium text-gray-900">
                                Results
                            </h4>
                            <div className="text-xs leading-relaxed text-slate-600">
                                <MarkdownContent
                                    citations={summaryCitations}
                                    onCitationClick={handleCitationOpen}
                                    column={column}
                                >
                                    {summaryText || "—"}
                                </MarkdownContent>
                            </div>
                        </div>

                        {/* Reasoning */}
                        {cell.content?.reasoning && (
                            <div>
                                <h4 className="mb-2 text-xs font-medium text-gray-900">
                                    Reasoning
                                </h4>
                                <div className="text-xs leading-relaxed text-slate-600">
                                    <MarkdownContent
                                        citations={reasoningCitations}
                                        onCitationClick={handleCitationOpen}
                                        citationOffset={summaryCitations.length}
                                        column={column}
                                        inline
                                    >
                                        {reasoningText}
                                    </MarkdownContent>
                                </div>
                            </div>
                        )}

                        {litigationEvidence && (
                            <section className="mt-6 border-t border-gray-900/[0.07] pt-4">
                                <h4 className="text-xs font-medium text-gray-900">
                                    Exact source citations
                                </h4>
                                {litigationEvidence.citations.length > 0 ? (
                                    <ul className="mt-2 space-y-2">
                                        {litigationEvidence.citations.map(
                                            (citation, citationIndex) => (
                                                <li
                                                    key={citation.citation_id}
                                                    className="rounded-md bg-white/55 p-2 text-[11px] leading-4 text-gray-600"
                                                >
                                                    <p className="font-medium text-gray-800">
                                                        {citation.locator.kind}:{" "}
                                                        {citation.locator.value}
                                                    </p>
                                                    <p className="mt-1 line-clamp-3 break-words [overflow-wrap:anywhere]">
                                                        {citation.quote}
                                                    </p>
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            handleStructuredCitationOpen(
                                                                citation,
                                                                citationIndex,
                                                            )
                                                        }
                                                        className="mt-1.5 text-[11px] font-medium text-blue-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70"
                                                    >
                                                        Open cited page
                                                    </button>
                                                </li>
                                            ),
                                        )}
                                    </ul>
                                ) : (
                                    <p className="mt-2 text-[11px] leading-4 text-gray-600">
                                        No generated citation is available. Keep
                                        this finding unresolved.
                                    </p>
                                )}

                                <div className="mt-4 border-t border-gray-900/[0.07] pt-3">
                                    {litigationEvidence.reviewStatus ===
                                        "verified" && (
                                        <p className="mb-2 inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700">
                                            <Check className="h-3 w-3" />
                                            Verified against source
                                        </p>
                                    )}
                                    {litigationEvidence.reviewStatus ===
                                        "unresolved" && (
                                        <p className="mb-2 text-[11px] font-medium text-amber-800">
                                            Kept unresolved
                                        </p>
                                    )}
                                    <div className="flex flex-wrap gap-2">
                                        <button
                                            type="button"
                                            onClick={() =>
                                                void litigationEvidence.onReview(
                                                    "verified",
                                                )
                                            }
                                            disabled={
                                                !litigationEvidence.reviewActive ||
                                                litigationEvidence.saving ||
                                                cell.status !== "done" ||
                                                cell.review_revision === undefined ||
                                                litigationEvidence.citations
                                                    .length === 0
                                            }
                                            className="inline-flex h-8 items-center rounded-full bg-gray-950 px-3 text-[11px] font-medium text-white outline-none transition-colors hover:bg-black focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-40"
                                        >
                                            Verify against source
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                void litigationEvidence.onReview(
                                                    "unresolved",
                                                )
                                            }
                                            disabled={
                                                !litigationEvidence.reviewActive ||
                                                litigationEvidence.saving ||
                                                cell.review_revision === undefined
                                            }
                                            className="inline-flex h-8 items-center rounded-full bg-white px-3 text-[11px] font-medium text-gray-700 shadow-sm outline-none transition-colors hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-40"
                                        >
                                            Keep unresolved
                                        </button>
                                    </div>
                                    {canRequestCorrection && (
                                        <div className="mt-3 border-t border-gray-900/[0.07] pt-3">
                                            <p className="text-[11px] font-medium text-gray-900">
                                                Need a new source-bound draft?
                                            </p>
                                            <p className="mt-1 text-[11px] leading-4 text-gray-600">
                                                Only this finding will be
                                                regenerated from its fixed
                                                source. The Work Task will
                                                resume and return here for
                                                review.
                                            </p>
                                            <label
                                                className="mt-2 block text-[11px] font-medium text-gray-700"
                                                htmlFor={`source-bound-correction-reason-${cell.id}`}
                                            >
                                                Source issue
                                            </label>
                                            <select
                                                id={`source-bound-correction-reason-${cell.id}`}
                                                value={
                                                    sourceBoundCorrectionReason
                                                }
                                                onChange={(event) =>
                                                    setSourceBoundCorrectionReason(
                                                        event.target
                                                            .value as SourceBoundCorrectionReasonCode,
                                                    )
                                                }
                                                disabled={
                                                    litigationEvidence.saving
                                                }
                                                className="mt-1 h-8 w-full rounded-md border border-gray-900/[0.12] bg-white px-2 text-[11px] text-gray-800 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500/70 disabled:cursor-default disabled:opacity-50"
                                            >
                                                {SOURCE_BOUND_CORRECTION_REASONS.map(
                                                    (reason) => (
                                                        <option
                                                            key={reason.code}
                                                            value={reason.code}
                                                        >
                                                            {reason.label}
                                                        </option>
                                                    ),
                                                )}
                                            </select>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    void litigationEvidence.onRequestSourceBoundCorrection(
                                                        sourceBoundCorrectionReason,
                                                    )
                                                }
                                                disabled={
                                                    litigationEvidence.saving
                                                }
                                                className="mt-2 inline-flex h-8 items-center rounded-full bg-white px-3 text-[11px] font-medium text-gray-700 shadow-sm outline-none transition-colors hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-40"
                                            >
                                                {litigationEvidence.saving
                                                    ? "Requesting…"
                                                    : "Request source-bound regeneration"}
                                            </button>
                                        </div>
                                    )}
                                    {!litigationEvidence.reviewActive && (
                                        <p className="mt-2 text-[11px] leading-4 text-gray-600">
                                            This Task is no longer awaiting this
                                            review.
                                        </p>
                                    )}
                                    {litigationEvidence.error && (
                                        <p
                                            role="alert"
                                            className="mt-2 text-[11px] leading-4 text-red-700"
                                        >
                                            {litigationEvidence.error}
                                        </p>
                                    )}
                                </div>
                            </section>
                        )}
                    </div>
                </div>
                <div className="flex shrink-0 justify-center bg-white/25 pb-7 pt-1">
                    <div className="grid grid-cols-3 grid-rows-3 gap-0.5">
                        <CellNavigatorButton
                            className="col-start-2 row-start-1"
                            label="Previous document"
                            title={previousDocument?.filename}
                            disabled={!previousDocument}
                            onClick={() =>
                                previousDocument &&
                                onNavigate(previousDocument.id, column.index)
                            }
                        >
                            <ChevronUp className="h-4 w-4" />
                        </CellNavigatorButton>
                        <CellNavigatorButton
                            className="col-start-1 row-start-2"
                            label="Previous column"
                            title={previousColumn?.name}
                            disabled={!previousColumn}
                            onClick={() =>
                                previousColumn &&
                                onNavigate(doc.id, previousColumn.index)
                            }
                        >
                            <ChevronLeft className="h-4 w-4" />
                        </CellNavigatorButton>
                        <div className="col-start-2 row-start-2 h-7 w-7 rounded-md bg-white/35" />
                        <CellNavigatorButton
                            className="col-start-3 row-start-2"
                            label="Next column"
                            title={nextColumn?.name}
                            disabled={!nextColumn}
                            onClick={() =>
                                nextColumn &&
                                onNavigate(doc.id, nextColumn.index)
                            }
                        >
                            <ChevronRight className="h-4 w-4" />
                        </CellNavigatorButton>
                        <CellNavigatorButton
                            className="col-start-2 row-start-3"
                            label="Next document"
                            title={nextDocument?.filename}
                            disabled={!nextDocument}
                            onClick={() =>
                                nextDocument &&
                                onNavigate(nextDocument.id, column.index)
                            }
                        >
                            <ChevronDown className="h-4 w-4" />
                        </CellNavigatorButton>
                    </div>
                </div>
            </div>
        </div>
    );
}

function CellNavigatorButton({
    label,
    title,
    disabled,
    onClick,
    className,
    children,
}: {
    label: string;
    title?: string;
    disabled: boolean;
    onClick: () => void;
    className?: string;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            title={title ? `${label}: ${title}` : label}
            className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md text-gray-600 transition-colors disabled:cursor-default disabled:opacity-25",
                APP_SURFACE_HOVER_CLASS,
                APP_SURFACE_PRESSED_CLASS,
                className,
            )}
        >
            {children}
        </button>
    );
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function formatCitationLocation(citation: ParsedCitation | TRPanelCitation): string {
    if ("locatorLabel" in citation && citation.locatorLabel) {
        return citation.locatorLabel;
    }
    if (citation.sheet && citation.cell) {
        return `${citation.sheet}, cell ${citation.cell}`;
    }
    return `Page ${citation.page ?? 1}`;
}

function citationKey(
    cellId: string,
    citation: ParsedCitation | TRPanelCitation,
): string {
    const location = citation.sheet
        ? `${citation.sheet}:${citation.cell ?? ""}`
        : `page:${citation.page ?? 1}`;
    return `tr-cell:${cellId}:${location}`;
}

function CitationBadge({
    index,
    citation,
    onClick,
}: {
    index: number;
    citation: ParsedCitation;
    onClick: (citation: TRPanelCitation) => void;
}) {
    return (
        <button
            type="button"
            data-page={citation.page}
            data-sheet={citation.sheet}
            data-cell={citation.cell}
            data-quote={citation.quote}
            title={`${formatCitationLocation(citation)}: "${citation.quote}"`}
            onClick={() =>
                onClick({
                    quote: citation.quote,
                    page: citation.page,
                    sheet: citation.sheet,
                    cell: citation.cell,
                    citationRef: index + 1,
                })
            }
            className="inline-flex items-center justify-center rounded-full bg-gray-200 w-3.5 h-3.5 text-[9px] font-medium text-gray-700 align-super cursor-pointer hover:bg-gray-300 transition-colors"
        >
            {index + 1}
        </button>
    );
}

function MarkdownContent({
    children,
    citations,
    onCitationClick,
    citationOffset = 0,
    column,
    inline,
}: {
    children: string;
    citations: ParsedCitation[];
    onCitationClick: (citation: TRPanelCitation) => void;
    inline?: boolean;
    citationOffset?: number;
    column?: ColumnConfig;
}) {
    if (!children) return null;

    const pills: string[] = [];
    let processed = children.replace(/\[\[([^\]]+)\]\]/g, (_, content) => {
        const idx = pills.length;
        pills.push(content);
        return `\`§p${idx}§\``;
    });
    processed = processed.replace(/§(\d+)§/g, (_, idx) => `\`§c${idx}§\``);

    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
                p: ({ node, ...props }) =>
                    inline ? (
                        <span {...props} />
                    ) : (
                        <p
                            className="mb-1.5 last:mb-0 leading-relaxed"
                            {...props}
                        />
                    ),
                ul: ({ node, ...props }) => (
                    <ul
                        className="list-disc pl-4 space-y-0.5 mb-1.5 last:mb-0"
                        {...props}
                    />
                ),
                ol: ({ node, ...props }) => (
                    <ol
                        className="list-decimal pl-4 space-y-0.5 mb-1.5 last:mb-0"
                        {...props}
                    />
                ),
                li: ({ node, ...props }) => <li {...props} />,
                strong: ({ node, ...props }) => (
                    <strong className="font-semibold" {...props} />
                ),
                em: ({ node, ...props }) => (
                    <em className="italic" {...props} />
                ),
                a: ({ node, href, children, ...props }) => (
                    <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:text-blue-700 underline"
                        {...props}
                    >
                        {children}
                    </a>
                ),
                code: ({ node, children: codeChildren, ...props }) => {
                    const t = String(codeChildren);
                    const citMatch = t.match(/^§c(\d+)§$/);
                    if (citMatch) {
                        const idx = parseInt(citMatch[1]);
                        const citation = citations[idx];
                        if (citation) {
                            return (
                                <CitationBadge
                                    index={citationOffset + idx}
                                    citation={citation}
                                    onClick={onCitationClick}
                                />
                            );
                        }
                    }
                    const pillMatch = t.match(/^§p(\d+)§$/);
                    if (pillMatch) {
                        const content = pills[parseInt(pillMatch[1])];
                        if (content !== undefined) {
                            return (
                                <span
                                    className={`inline-block rounded-full px-1.5 py-0.5 text-[11px] font-medium leading-none ${getPillClass(content, column)}`}
                                >
                                    {content}
                                </span>
                            );
                        }
                    }
                    return (
                        <code
                            className="bg-gray-100 px-1 py-0.5 rounded text-[11px] font-mono"
                            {...props}
                        >
                            {codeChildren}
                        </code>
                    );
                },
            }}
        >
            {processed}
        </ReactMarkdown>
    );
}
