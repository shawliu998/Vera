"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  LoaderCircle,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist";
import { getPdfJs } from "@/app/components/shared/highlightQuote";
import {
  getLitigationSourceSpanOriginalVerificationHistory,
  type LitigationSourceOriginalVerificationHistoryItem,
} from "@/app/lib/aletheiaApi";
import {
  fetchVerifiedAletheiaOriginal,
  useOriginalDocumentAccess,
} from "./originalDocumentAccess";

const ZOOM_LEVELS = [75, 100, 125, 150, 200] as const;

type ViewerPhase = "loading" | "ready" | "empty" | "error";
type HistoryPhase = "loading" | "ready" | "empty" | "error";

function shortHash(value: string) {
  return value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function formatHistoryTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "Time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function HistoryHash({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="text-gray-500">{label}</span>
      <code
        className="min-w-0 truncate font-mono text-[10px] text-gray-700"
        title={`${label} sha256: ${value}`}
      >
        {shortHash(value)}
      </code>
      <button
        type="button"
        aria-label={`Copy ${label} hash`}
        title={`Copy full ${label} hash`}
        onClick={() => void navigator.clipboard.writeText(value)}
        className="grid h-6 w-6 shrink-0 place-items-center text-gray-400 hover:bg-gray-100 hover:text-gray-800"
      >
        <Copy className="h-3 w-3" />
      </button>
    </span>
  );
}

export type OriginalEvidenceComparisonContext = {
  sourceSpanId: string;
  exactQuote: string;
  ocrPage?: number | null;
  ocrConfidence?: number | null;
  verification?: {
    id: string;
    reason?: string | null;
    verifiedAt?: string | null;
  } | null;
  saving: boolean;
  onVerify: (reason: string) => Promise<void>;
  onWithdraw: (verificationId: string, reason: string) => Promise<void>;
};

export type OriginalEvidenceViewerProps = {
  open: boolean;
  matterId: string;
  documentId: string;
  filename: string;
  recordedPage?: number | null;
  comparison?: OriginalEvidenceComparisonContext;
  onClose: () => void;
};

export function OriginalEvidenceViewer({
  open,
  matterId,
  documentId,
  filename,
  recordedPage,
  comparison,
  onClose,
}: OriginalEvidenceViewerProps) {
  const [phase, setPhase] = useState<ViewerPhase>("loading");
  const [failure, setFailure] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState<number>(100);
  const [rendering, setRendering] = useState(false);
  const [comparisonReason, setComparisonReason] = useState("");
  const [comparisonState, setComparisonState] = useState<
    "idle" | "submitting" | "failed" | "success"
  >("idle");
  const [withdrawalOpen, setWithdrawalOpen] = useState(false);
  const [withdrawalReason, setWithdrawalReason] = useState("");
  const [withdrawalState, setWithdrawalState] = useState<
    "idle" | "submitting" | "failed"
  >("idle");
  const [historyPhase, setHistoryPhase] = useState<HistoryPhase>("loading");
  const [historyItems, setHistoryItems] = useState<
    LitigationSourceOriginalVerificationHistoryItem[]
  >([]);
  const [historyReload, setHistoryReload] = useState(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const bytesRef = useRef<Uint8Array | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const access = useOriginalDocumentAccess();
  const trimmedComparisonReason = comparisonReason.trim();
  const comparisonReasonValid =
    trimmedComparisonReason.length >= 10 &&
    trimmedComparisonReason.length <= 2000;
  const trimmedWithdrawalReason = withdrawalReason.trim();
  const withdrawalReasonValid =
    trimmedWithdrawalReason.length >= 10 &&
    trimmedWithdrawalReason.length <= 2000;
  const comparisonPage = comparison?.ocrPage ?? recordedPage ?? null;
  const isComparisonPage =
    phase === "ready" &&
    Number.isInteger(comparisonPage) &&
    pageNumber === comparisonPage;

  useEffect(() => {
    setComparisonReason("");
    setComparisonState("idle");
  }, [comparison?.sourceSpanId]);

  useEffect(() => {
    setWithdrawalOpen(false);
    setWithdrawalReason("");
    setWithdrawalState("idle");
  }, [comparison?.verification?.id]);

  useEffect(() => {
    if (!open || !comparison?.sourceSpanId) return;
    let active = true;
    setHistoryPhase("loading");
    void getLitigationSourceSpanOriginalVerificationHistory(
      matterId,
      comparison.sourceSpanId,
    )
      .then((history) => {
        if (!active) return;
        setHistoryItems(history.items);
        setHistoryPhase(history.items.length ? "ready" : "empty");
      })
      .catch(() => {
        if (!active) return;
        setHistoryItems([]);
        setHistoryPhase("error");
      });
    return () => {
      active = false;
    };
  }, [comparison?.sourceSpanId, historyReload, matterId, open]);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = 0;
    canvas.height = 0;
    canvas.style.width = "0px";
    canvas.style.height = "0px";
  }, []);

  const releaseDocument = useCallback(() => {
    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;
    const pdf = pdfRef.current;
    pdfRef.current = null;
    const loadingTask = loadingTaskRef.current;
    loadingTaskRef.current = null;
    if (pdf) void pdf.destroy().catch(() => undefined);
    if (loadingTask) void loadingTask.destroy().catch(() => undefined);
    try {
      bytesRef.current?.fill(0);
    } catch {
      // PDF.js may transfer the backing buffer to its local worker.
    }
    bytesRef.current = null;
    clearCanvas();
  }, [clearCanvas]);

  useEffect(() => {
    if (!open) {
      releaseDocument();
      return;
    }

    let active = true;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    setPhase("loading");
    setFailure("");
    setPageCount(0);
    setPageNumber(1);
    setZoom(100);

    void (async () => {
      try {
        const original = await fetchVerifiedAletheiaOriginal(
          matterId,
          documentId,
        );
        if (!active) return;
        if (original.mimeType.trim().toLowerCase() !== "application/pdf") {
          throw new Error("original_not_pdf");
        }
        const bytes = new Uint8Array(await original.blob.arrayBuffer());
        if (!active) {
          bytes.fill(0);
          return;
        }
        bytesRef.current = bytes;
        const pdfjs = await getPdfJs();
        if (!active) return;
        const loadingTask = pdfjs.getDocument({
          data: bytes,
          isEvalSupported: false,
        });
        loadingTaskRef.current = loadingTask;
        const pdf = await loadingTask.promise;
        if (!active) {
          await pdf.destroy();
          return;
        }
        pdfRef.current = pdf;
        if (pdf.numPages < 1) {
          setPhase("empty");
          return;
        }
        if (
          recordedPage !== null &&
          recordedPage !== undefined &&
          (!Number.isInteger(recordedPage) ||
            recordedPage < 1 ||
            recordedPage > pdf.numPages)
        ) {
          setFailure(
            `Recorded page ${String(recordedPage)} is outside this ${pdf.numPages}-page PDF. Nothing was displayed.`,
          );
          setPageCount(pdf.numPages);
          setPhase("error");
          releaseDocument();
          return;
        }
        setPageCount(pdf.numPages);
        setPageNumber(recordedPage ?? 1);
        setPhase("ready");
      } catch (reason) {
        if (!active) return;
        const message =
          reason instanceof Error && reason.message === "original_not_pdf"
            ? "The fetched original is not a PDF. Nothing was displayed."
            : "The original PDF could not be loaded after its byte integrity check. Nothing was displayed.";
        setFailure(message);
        setPhase("error");
        releaseDocument();
      }
    })();

    return () => {
      active = false;
      document.body.style.overflow = previousOverflow;
      releaseDocument();
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [documentId, matterId, open, recordedPage, releaseDocument]);

  useEffect(() => {
    const pdf = pdfRef.current;
    const canvas = canvasRef.current;
    if (!open || phase !== "ready" || !pdf || !canvas) return;
    let active = true;
    renderTaskRef.current?.cancel();
    clearCanvas();
    setRendering(true);

    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (!active) return;
        const viewport = page.getViewport({ scale: zoom / 100 });
        const outputScale = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.ceil(viewport.width * outputScale);
        canvas.height = Math.ceil(viewport.height * outputScale);
        const availableWidth = Math.max(
          1,
          (stageRef.current?.clientWidth ?? viewport.width + 40) - 40,
        );
        const displayScale = Math.min(1, availableWidth / viewport.width);
        canvas.style.width = `${Math.ceil(viewport.width * displayScale)}px`;
        canvas.style.height = `${Math.ceil(viewport.height * displayScale)}px`;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("canvas_context_unavailable");
        context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
        const task = page.render({ canvasContext: context, viewport });
        renderTaskRef.current = task;
        await task.promise;
        if (active) setRendering(false);
      } catch (reason) {
        if (
          !active ||
          (reason as { name?: string })?.name === "RenderingCancelledException"
        ) {
          return;
        }
        setFailure(
          "This PDF page could not be rendered. Nothing was displayed.",
        );
        setPhase("error");
        setRendering(false);
        releaseDocument();
      }
    })();

    return () => {
      active = false;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
  }, [clearCanvas, open, pageNumber, phase, releaseDocument, zoom]);

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const controls = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function submitComparison() {
    if (
      !comparison ||
      !comparisonReasonValid ||
      !isComparisonPage ||
      comparison.saving ||
      comparisonState === "submitting"
    ) {
      return;
    }
    setComparisonState("submitting");
    try {
      await comparison.onVerify(trimmedComparisonReason);
      setComparisonState("success");
      setHistoryReload((value) => value + 1);
    } catch {
      setComparisonState("failed");
    }
  }

  async function submitWithdrawal() {
    if (
      !comparison?.verification ||
      !withdrawalReasonValid ||
      comparison.saving ||
      withdrawalState === "submitting"
    ) {
      return;
    }
    setWithdrawalState("submitting");
    try {
      await comparison.onWithdraw(
        comparison.verification.id,
        trimmedWithdrawalReason,
      );
      setHistoryReload((value) => value + 1);
    } catch {
      setWithdrawalState("failed");
    }
  }

  if (!open) return null;

  const recordedPageCopy =
    recordedPage === null || recordedPage === undefined
      ? "No citation page was recorded; page 1 is the starting page."
      : `Recorded citation page ${String(recordedPage)}. Comparison is available only while that exact page is displayed.`;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-0 sm:p-4"
      data-testid="original-evidence-viewer-overlay"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="original-evidence-viewer-title"
        aria-describedby="original-evidence-viewer-context"
        aria-busy={phase === "loading" || rendering}
        onKeyDown={handleDialogKeyDown}
        className="flex h-[100dvh] w-full min-w-0 flex-col overflow-hidden border border-gray-300 bg-[#f7f7f8] shadow-2xl sm:h-[min(92dvh,900px)] sm:w-[min(1120px,calc(100vw-32px))]"
        data-testid="original-evidence-viewer"
      >
        <header className="flex min-w-0 shrink-0 items-start gap-3 border-b border-gray-300 bg-white px-3 py-3 sm:px-4">
          <div className="min-w-0 flex-1">
            <h2
              id="original-evidence-viewer-title"
              className="truncate text-sm font-semibold text-gray-950"
              title={filename}
            >
              {filename}
            </h2>
            <p
              id="original-evidence-viewer-context"
              className="mt-0.5 text-[11px] leading-4 text-gray-500"
            >
              {recordedPageCopy} Viewing does not record a comparison.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            title="Close original inspector"
            aria-label="Close original inspector"
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-gray-300 bg-[#fcfcfd] px-3 py-2 sm:px-4">
          <div className="flex items-center gap-1">
            <button
              type="button"
              title="Previous page"
              aria-label="Previous page"
              disabled={phase !== "ready" || rendering || pageNumber <= 1}
              onClick={() => setPageNumber((current) => current - 1)}
              className="grid h-8 w-8 place-items-center border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-35"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <output
              aria-label="PDF page position"
              className="min-w-[86px] text-center text-xs tabular-nums text-gray-700"
            >
              Page {pageCount ? pageNumber : 0} / {pageCount}
            </output>
            <button
              type="button"
              title="Next page"
              aria-label="Next page"
              disabled={
                phase !== "ready" || rendering || pageNumber >= pageCount
              }
              onClick={() => setPageNumber((current) => current + 1)}
              className="grid h-8 w-8 place-items-center border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-35"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              title="Zoom out"
              aria-label="Zoom out"
              disabled={
                phase !== "ready" || rendering || zoom === ZOOM_LEVELS[0]
              }
              onClick={() => {
                const index = ZOOM_LEVELS.indexOf(
                  zoom as (typeof ZOOM_LEVELS)[number],
                );
                setZoom(ZOOM_LEVELS[Math.max(0, index - 1)]);
              }}
              className="grid h-8 w-8 place-items-center border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-35"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <output
              aria-label="PDF zoom level"
              className="min-w-[48px] text-center text-xs tabular-nums text-gray-700"
            >
              {zoom}%
            </output>
            <button
              type="button"
              title="Zoom in"
              aria-label="Zoom in"
              disabled={
                phase !== "ready" || rendering || zoom === ZOOM_LEVELS.at(-1)
              }
              onClick={() => {
                const index = ZOOM_LEVELS.indexOf(
                  zoom as (typeof ZOOM_LEVELS)[number],
                );
                setZoom(
                  ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, index + 1)],
                );
              }}
              className="grid h-8 w-8 place-items-center border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-35"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div
          className={
            comparison
              ? "grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(180px,30%)_minmax(0,1fr)] overflow-hidden lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-1"
              : "min-h-0 min-w-0 flex-1 overflow-hidden"
          }
        >
          <div
            ref={stageRef}
            className="relative h-full min-h-0 min-w-0 overflow-auto bg-[#d8dadd] p-3 sm:p-5"
          >
            {(phase === "loading" || rendering) && (
              <div
                role="status"
                className="absolute left-1/2 top-4 z-10 inline-flex -translate-x-1/2 items-center gap-2 border border-gray-300 bg-white px-3 py-2 text-xs text-gray-700 shadow-sm"
              >
                <LoaderCircle className="h-4 w-4 animate-spin" />
                {phase === "loading"
                  ? "Checking byte integrity and loading PDF"
                  : "Rendering page"}
              </div>
            )}
            {phase === "error" && (
              <div
                role="alert"
                className="mx-auto mt-8 max-w-xl border border-red-300 bg-white p-4 text-sm leading-6 text-red-800"
              >
                <div className="font-semibold">
                  Original inspection unavailable
                </div>
                <p className="mt-1">{failure}</p>
              </div>
            )}
            {phase === "empty" && (
              <div
                role="status"
                className="mx-auto mt-8 max-w-xl border border-gray-300 bg-white p-4 text-sm text-gray-700"
              >
                This PDF has no pages to display.
              </div>
            )}
            <canvas
              ref={canvasRef}
              aria-label={`Original PDF page ${pageNumber}`}
              data-testid="original-evidence-canvas"
              className={`mx-auto block bg-white shadow-sm ${phase === "ready" ? "" : "invisible"}`}
            />
          </div>
          {comparison && (
            <aside
              aria-label="Original text comparison"
              data-testid="original-comparison-inspector"
              className="min-h-0 min-w-0 overflow-y-auto border-t border-gray-300 bg-white px-4 py-3 lg:border-l lg:border-t-0"
            >
              <div className="text-xs font-semibold text-gray-950">
                Original text comparison
              </div>
              <p className="mt-1 text-[11px] leading-4 text-gray-600">
                Compare the displayed quote with the recorded page in the
                protected original. This records transcription comparison only,
                not authenticity, admissibility, file safety, or substantive
                truth.
              </p>
              <dl className="mt-3 border-y border-gray-200 py-2 text-[11px] leading-4">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-gray-500">Recorded page</dt>
                  <dd className="font-medium tabular-nums text-gray-800">
                    {comparisonPage ?? "Not recorded"}
                  </dd>
                </div>
                <div className="mt-1 flex items-baseline justify-between gap-3">
                  <dt className="text-gray-500">Currently displayed page</dt>
                  <dd className="font-medium tabular-nums text-gray-800">
                    {phase === "ready" ? pageNumber : "Not available"}
                  </dd>
                </div>
                <div className="mt-1 flex items-baseline justify-between gap-3">
                  <dt className="text-gray-500">OCR confidence</dt>
                  <dd className="font-medium tabular-nums text-gray-800">
                    {typeof comparison.ocrConfidence === "number" &&
                    Number.isFinite(comparison.ocrConfidence)
                      ? `${Math.round(comparison.ocrConfidence * 100)}%`
                      : "Not recorded"}
                  </dd>
                </div>
              </dl>
              <div className="mt-3">
                <div className="text-[11px] font-medium text-gray-600">
                  Exact recorded quote
                </div>
                <blockquote className="mt-1 max-h-36 overflow-y-auto border-l-2 border-gray-300 pl-3 text-xs leading-5 text-gray-900 [overflow-wrap:anywhere]">
                  “{comparison.exactQuote}”
                </blockquote>
              </div>

              {comparison.verification ? (
                <div
                  data-testid="original-comparison-verified"
                  className="mt-4 border-t border-emerald-300 pt-3 text-xs leading-5"
                >
                  <div role="status" className="text-emerald-800">
                    <div className="font-semibold">
                      Text comparison recorded
                    </div>
                    <p>
                      Counsel recorded a transcription comparison for this
                      source span. Actor provenance is assigned by the
                      authenticated backend.
                    </p>
                  </div>
                  {!withdrawalOpen ? (
                    <button
                      type="button"
                      onClick={() => setWithdrawalOpen(true)}
                      className="mt-3 font-medium text-gray-700 underline decoration-gray-400 underline-offset-2 hover:text-gray-950"
                    >
                      Withdraw or correct recorded comparison
                    </button>
                  ) : (
                    <div
                      data-testid="original-comparison-withdrawal-confirmation"
                      className="mt-3 border-t border-gray-200 pt-3 text-gray-700"
                    >
                      <div className="font-semibold text-gray-950">
                        Confirm withdrawal or correction
                      </div>
                      <p className="mt-1 text-[11px] leading-4 text-gray-600">
                        The historical verification remains in the audit
                        history. Withdrawing it reopens the low-confidence
                        comparison gate so counsel can record a corrected
                        comparison.
                      </p>
                      <label
                        htmlFor={`original-comparison-withdrawal-reason-${comparison.sourceSpanId}`}
                        className="mt-3 block text-[11px] font-medium text-gray-700"
                      >
                        Reason for withdrawal or correction
                      </label>
                      <textarea
                        id={`original-comparison-withdrawal-reason-${comparison.sourceSpanId}`}
                        aria-label="Reason for withdrawal or correction"
                        value={withdrawalReason}
                        maxLength={2000}
                        disabled={
                          comparison.saving || withdrawalState === "submitting"
                        }
                        onChange={(event) => {
                          setWithdrawalReason(event.target.value);
                          if (withdrawalState === "failed") {
                            setWithdrawalState("idle");
                          }
                        }}
                        placeholder="Explain why the recorded comparison must be withdrawn or corrected."
                        className="mt-1 min-h-24 w-full resize-y border border-gray-300 bg-white px-2.5 py-2 text-xs leading-5 text-gray-900 outline-none focus:border-gray-600 disabled:bg-gray-100"
                      />
                      <div className="mt-1 flex items-start justify-between gap-3 text-[11px] leading-4">
                        <span
                          className={
                            withdrawalReasonValid
                              ? "text-gray-500"
                              : "text-amber-700"
                          }
                        >
                          10-2000 characters required
                        </span>
                        <span className="shrink-0 tabular-nums text-gray-500">
                          {withdrawalReason.length}/2000
                        </span>
                      </div>
                      {withdrawalState === "failed" && (
                        <p
                          role="alert"
                          className="mt-2 text-xs leading-5 text-red-700"
                        >
                          The recorded comparison could not be withdrawn. Your
                          reason is preserved; review it and retry.
                        </p>
                      )}
                      <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        <button
                          type="button"
                          disabled={
                            comparison.saving ||
                            withdrawalState === "submitting"
                          }
                          onClick={() => {
                            setWithdrawalOpen(false);
                            setWithdrawalReason("");
                            setWithdrawalState("idle");
                          }}
                          className="h-9 border border-gray-300 bg-white px-3 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={
                            !withdrawalReasonValid ||
                            comparison.saving ||
                            withdrawalState === "submitting"
                          }
                          onClick={() => void submitWithdrawal()}
                          className="inline-flex h-9 items-center justify-center gap-2 border border-red-700 bg-white px-3 text-xs font-medium text-red-800 hover:bg-red-50 disabled:border-gray-300 disabled:bg-gray-100 disabled:text-gray-500"
                        >
                          {(comparison.saving ||
                            withdrawalState === "submitting") && (
                            <LoaderCircle className="h-4 w-4 animate-spin" />
                          )}
                          {comparison.saving || withdrawalState === "submitting"
                            ? "Withdrawing comparison"
                            : "Confirm withdrawal"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-4 border-t border-gray-200 pt-3">
                  <label
                    htmlFor={`original-comparison-reason-${comparison.sourceSpanId}`}
                    className="text-[11px] font-medium text-gray-700"
                  >
                    Counsel comparison reason
                  </label>
                  <textarea
                    id={`original-comparison-reason-${comparison.sourceSpanId}`}
                    aria-label="Counsel comparison reason"
                    value={comparisonReason}
                    maxLength={2000}
                    onChange={(event) => {
                      setComparisonReason(event.target.value);
                      if (comparisonState === "failed") {
                        setComparisonState("idle");
                      }
                    }}
                    placeholder="Describe the words and page compared."
                    className="mt-1 min-h-24 w-full resize-y border border-gray-300 bg-white px-2.5 py-2 text-xs leading-5 text-gray-900 outline-none focus:border-gray-600"
                  />
                  <div className="mt-1 flex items-start justify-between gap-3 text-[11px] leading-4">
                    <span
                      className={
                        comparisonReasonValid
                          ? "text-gray-500"
                          : "text-amber-700"
                      }
                    >
                      10-2000 characters required
                    </span>
                    <span className="shrink-0 tabular-nums text-gray-500">
                      {comparisonReason.length}/2000
                    </span>
                  </div>
                  {!isComparisonPage && comparisonPage !== null && (
                    <div className="mt-2 border-l-2 border-amber-400 pl-2 text-xs leading-5 text-amber-800">
                      <p>
                        Comparison can be recorded only while page{" "}
                        {comparisonPage} is displayed.
                      </p>
                      <button
                        type="button"
                        disabled={phase !== "ready" || rendering}
                        onClick={() => setPageNumber(comparisonPage)}
                        className="mt-1 font-semibold text-amber-900 underline decoration-amber-500 underline-offset-2 disabled:opacity-50"
                      >
                        Return to recorded page {comparisonPage}
                      </button>
                    </div>
                  )}
                  {comparisonState === "failed" && (
                    <p
                      role="alert"
                      className="mt-2 text-xs leading-5 text-red-700"
                    >
                      The text comparison could not be recorded. Your reason is
                      preserved; review it and retry.
                    </p>
                  )}
                  {comparisonState === "success" && (
                    <p
                      role="status"
                      className="mt-2 text-xs leading-5 text-emerald-700"
                    >
                      Text comparison recorded.
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={
                      !comparisonReasonValid ||
                      !isComparisonPage ||
                      comparison.saving ||
                      comparisonState === "submitting"
                    }
                    onClick={() => void submitComparison()}
                    className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 bg-gray-950 px-3 text-xs font-medium text-white hover:bg-gray-800 disabled:bg-gray-300 disabled:text-gray-600"
                  >
                    {(comparison.saving ||
                      comparisonState === "submitting") && (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    )}
                    {comparison.saving || comparisonState === "submitting"
                      ? "Recording text comparison"
                      : "Record text comparison"}
                  </button>
                </div>
              )}
              <details
                open
                data-testid="original-verification-history"
                className="mt-4 border-t border-gray-300 pt-3"
              >
                <summary className="cursor-pointer select-none text-xs font-semibold text-gray-950 marker:text-gray-500">
                  Comparison history
                </summary>
                <div className="mt-2" aria-live="polite">
                  {historyPhase === "loading" && (
                    <div
                      role="status"
                      className="flex items-center gap-2 py-2 text-[11px] text-gray-600"
                    >
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      Loading verification history
                    </div>
                  )}
                  {historyPhase === "error" && (
                    <div role="alert" className="border-l-2 border-red-400 pl-2">
                      <p className="text-[11px] leading-4 text-red-800">
                        Verification history is unavailable. This is not an
                        empty history.
                      </p>
                      <button
                        type="button"
                        onClick={() => setHistoryReload((value) => value + 1)}
                        className="mt-1 text-[11px] font-semibold text-gray-700 underline decoration-gray-400 underline-offset-2 hover:text-gray-950"
                      >
                        Retry history
                      </button>
                    </div>
                  )}
                  {historyPhase === "empty" && (
                    <p role="status" className="py-2 text-[11px] text-gray-600">
                      No verification or withdrawal has been recorded for this
                      citation.
                    </p>
                  )}
                  {historyPhase === "ready" && (
                    <ol className="border-b border-gray-200">
                      {historyItems.map((item) => (
                        <li
                          key={item.id}
                          data-testid={`original-verification-history-item-${item.id}`}
                          className="border-t border-gray-200 py-3 text-[11px] leading-4 text-gray-700"
                        >
                          <div className="flex min-w-0 items-start justify-between gap-3">
                            <div className="font-semibold text-gray-900">
                              {item.withdrawal
                                ? "Withdrawn comparison"
                                : item.current
                                  ? "Current comparison"
                                  : "Recorded comparison"}
                            </div>
                            <div
                              className={`shrink-0 font-medium ${
                                item.withdrawal
                                  ? "text-red-700"
                                  : item.current
                                    ? "text-emerald-700"
                                    : "text-gray-500"
                              }`}
                            >
                              {item.withdrawal
                                ? "Withdrawn"
                                : item.current
                                  ? "Current"
                                  : "Historical"}
                            </div>
                          </div>
                          <div className="mt-1 text-gray-500">
                            <span className="text-gray-700">
                              {item.verifiedBy || "Actor unavailable"}
                            </span>{" "}
                            ·{" "}
                            <time dateTime={item.verifiedAt} title={item.verifiedAt}>
                              {formatHistoryTime(item.verifiedAt)}
                            </time>
                          </div>
                          <p className="mt-1 break-words text-gray-800 [overflow-wrap:anywhere]">
                            {item.reason || "No verification reason recorded."}
                          </p>
                          <div className="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1">
                            <HistoryHash
                              label="Source"
                              value={item.sourceChunkSha256}
                            />
                            <HistoryHash label="Quote" value={item.quoteSha256} />
                          </div>
                          {item.withdrawal && (
                            <div className="mt-2 border-l-2 border-gray-300 pl-2">
                              <div className="text-gray-500">
                                Withdrawn by{" "}
                                <span className="text-gray-700">
                                  {item.withdrawal.withdrawnBy ||
                                    "Actor unavailable"}
                                </span>{" "}
                                ·{" "}
                                <time
                                  dateTime={item.withdrawal.withdrawnAt}
                                  title={item.withdrawal.withdrawnAt}
                                >
                                  {formatHistoryTime(
                                    item.withdrawal.withdrawnAt,
                                  )}
                                </time>
                              </div>
                              <p className="mt-1 break-words text-gray-800 [overflow-wrap:anywhere]">
                                {item.withdrawal.reason ||
                                  "No withdrawal reason recorded."}
                              </p>
                            </div>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </details>
            </aside>
          )}
        </div>

        <footer className="flex min-w-0 shrink-0 flex-col gap-2 border-t border-gray-300 bg-white px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
          <p className="min-w-0 text-[11px] leading-4 text-gray-500">
            Stored byte integrity verified before rendering. This does not
            establish authenticity, admissibility, or safety.
          </p>
          <div className="shrink-0 sm:text-right">
            <button
              type="button"
              disabled={access.status === "busy"}
              onClick={() =>
                void access.saveAndOpen({
                  matterId,
                  documentId,
                  suggestedName: filename,
                })
              }
              className="inline-flex h-9 w-full items-center justify-center gap-2 border border-gray-300 bg-white px-3 text-xs font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50 sm:w-auto"
            >
              {access.status === "busy" ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <ExternalLink className="h-4 w-4" />
              )}
              Save &amp; open original
            </button>
            {access.status !== "idle" && (
              <p
                role="status"
                className="mt-1 max-w-sm text-[11px] leading-4 text-gray-500"
              >
                {access.message}
              </p>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
