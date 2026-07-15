"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Clock3,
  Copy,
  Download,
  FileUp,
  History,
  Loader2,
  Quote,
  RefreshCw,
  RotateCcw,
  Save,
  ScanSearch,
  Sparkles,
  X,
} from "lucide-react";
import { ConfirmPopup } from "@/app/components/shared/ConfirmPopup";
import { VeraRichTextEditor } from "@/app/components/shared/VeraRichTextEditor";
import { useI18n } from "@/app/i18n";
import { VeraApiError } from "@/app/lib/veraApi";
import {
  acceptVeraStudioSuggestion,
  exportVeraStudioDocx,
  getVeraStudioSuggestion,
  getVeraStudioDocument,
  importVeraStudioDocx,
  listVeraStudioSuggestions,
  listVeraStudioVersions,
  rejectVeraStudioSuggestion,
  restoreVeraStudioVersion,
  saveVeraStudioDocument,
  veraStudioSuggestionMatchesPreview,
  type VeraStudioDocumentWire,
  type VeraStudioDocxWarningCode,
  type VeraStudioCitationAnchorWire,
  type VeraStudioSuggestionPreviewPageWire,
  type VeraStudioSuggestionWire,
  type VeraStudioVersionsWire,
} from "@/app/lib/veraDocumentStudioApi";
import {
  resolveVeraProjectCitation,
  type VeraResolvedProjectCitation,
} from "@/app/lib/veraProjectSourceApi";
import { ProjectCitationSourceViewer } from "./ProjectCitationSourceViewer";
import { ProjectSectionToolbar } from "./ProjectWorkspace";

interface Props {
  projectId: string;
  documentId: string;
}

type OperationErrorKind =
  | "load"
  | "save"
  | "import"
  | "export"
  | "restore"
  | "versions"
  | "clipboard"
  | "offline"
  | "conflict";

function isOfflineFailure(error: unknown) {
  return (
    error instanceof TypeError ||
    (typeof navigator !== "undefined" && navigator.onLine === false)
  );
}

function isVersionConflict(error: unknown) {
  return (
    error instanceof VeraApiError &&
    error.status === 409 &&
    error.code === "CONFLICT"
  );
}

function shortId(value: string) {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export function DocumentStudioView({ projectId, documentId }: Props) {
  const router = useRouter();
  const { t, formatDate, formatFileSize } = useI18n();
  const [document, setDocument] = useState<VeraStudioDocumentWire | null>(null);
  const [versions, setVersions] = useState<VeraStudioVersionsWire | null>(null);
  const [workingContent, setWorkingContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [historical, setHistorical] = useState<VeraStudioDocumentWire | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<OperationErrorKind | null>(null);
  const [versionError, setVersionError] = useState(false);
  const [suggestionPage, setSuggestionPage] =
    useState<VeraStudioSuggestionPreviewPageWire | null>(null);
  const [selectedSuggestion, setSelectedSuggestion] =
    useState<VeraStudioSuggestionWire | null>(null);
  const [suggestionsLoading, setSuggestionsLoading] = useState(true);
  const [suggestionLoadingId, setSuggestionLoadingId] = useState<string | null>(
    null,
  );
  const [suggestionDecisionId, setSuggestionDecisionId] = useState<
    string | null
  >(null);
  const [suggestionDecisionAction, setSuggestionDecisionAction] = useState<
    "accept" | "reject" | null
  >(null);
  const [suggestionError, setSuggestionError] = useState(false);
  const [suggestionAnnouncement, setSuggestionAnnouncement] = useState<
    string | null
  >(null);
  const [reloadConfirmOpen, setReloadConfirmOpen] = useState(false);
  const [sourceLoadingId, setSourceLoadingId] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState(false);
  const [resolvedCitation, setResolvedCitation] =
    useState<VeraResolvedProjectCitation | null>(null);
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const [docxWarnings, setDocxWarnings] = useState<{
    operation: "import" | "export";
    codes: VeraStudioDocxWarningCode[];
  } | null>(null);
  const historyControllerRef = useRef<AbortController | null>(null);
  const sourceControllerRef = useRef<AbortController | null>(null);
  const suggestionControllerRef = useRef<AbortController | null>(null);
  const suggestionPanelRef = useRef<HTMLElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const dirty = document !== null && workingContent !== savedContent;
  const displayDocument = historical ?? document;

  const errorText = useMemo(() => {
    if (errorKind === "offline") return t("studio.errors.offline");
    if (errorKind === "conflict") return t("studio.errors.conflict");
    if (errorKind === "restore") return t("studio.errors.restore");
    if (errorKind === "versions") return t("studio.errors.versions");
    if (errorKind === "clipboard") return t("studio.errors.clipboard");
    if (errorKind === "import") return t("studio.errors.import");
    if (errorKind === "export") return t("studio.errors.export");
    if (errorKind === "save") return t("studio.errors.save");
    if (errorKind === "load") return t("studio.errors.load");
    return null;
  }, [errorKind, t]);

  const docxWarningText = useCallback(
    (code: VeraStudioDocxWarningCode) => {
      switch (code) {
        case "DOCX_IMAGES_IGNORED":
          return t("studio.docx.warnings.DOCX_IMAGES_IGNORED");
        case "DOCX_FORMATTING_SIMPLIFIED":
          return t("studio.docx.warnings.DOCX_FORMATTING_SIMPLIFIED");
        case "DOCX_CONVERTER_WARNING":
          return t("studio.docx.warnings.DOCX_CONVERTER_WARNING");
        case "MARKDOWN_IMAGES_OMITTED":
          return t("studio.docx.warnings.MARKDOWN_IMAGES_OMITTED");
        case "MARKDOWN_HTML_AS_TEXT":
          return t("studio.docx.warnings.MARKDOWN_HTML_AS_TEXT");
        case "MARKDOWN_BLOCKQUOTE_SIMPLIFIED":
          return t("studio.docx.warnings.MARKDOWN_BLOCKQUOTE_SIMPLIFIED");
      }
    },
    [t],
  );

  const applyCurrent = useCallback(
    (next: VeraStudioDocumentWire) => {
      if (
        next.project_id !== projectId ||
        next.document_id !== documentId ||
        next.version.id !== next.current_version_id
      ) {
        throw new VeraApiError({
          status: 200,
          code: "INVALID_RESPONSE",
          message: "The Vera API returned an invalid current Studio document.",
        });
      }
      setDocument(next);
      setWorkingContent(next.content);
      setSavedContent(next.content);
      setHistorical(null);
    },
    [documentId, projectId],
  );

  const loadCurrent = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setSuggestionsLoading(true);
      setErrorKind(null);
      setVersionError(false);
      try {
        const [documentResult, versionsResult, suggestionsResult] =
          await Promise.allSettled([
            getVeraStudioDocument(projectId, documentId, undefined, signal),
            listVeraStudioVersions(projectId, documentId, signal),
            listVeraStudioSuggestions(projectId, documentId, signal),
          ]);
        if (signal?.aborted) return;
        if (documentResult.status === "rejected") {
          throw documentResult.reason;
        }
        applyCurrent(documentResult.value);
        if (versionsResult.status === "fulfilled") {
          setVersions(versionsResult.value);
        } else {
          setVersions(null);
          setVersionError(true);
        }
        if (suggestionsResult.status === "fulfilled") {
          setSuggestionPage(suggestionsResult.value);
          setSuggestionError(false);
        } else {
          setSuggestionPage(null);
          setSelectedSuggestion(null);
          setSuggestionError(true);
        }
      } catch (error) {
        if (signal?.aborted) return;
        setSuggestionPage(null);
        setSelectedSuggestion(null);
        setErrorKind(isOfflineFailure(error) ? "offline" : "load");
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
          setSuggestionsLoading(false);
        }
      }
    },
    [applyCurrent, documentId, projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadCurrent(controller.signal);
    return () => {
      controller.abort();
      historyControllerRef.current?.abort();
      sourceControllerRef.current?.abort();
      suggestionControllerRef.current?.abort();
    };
  }, [loadCurrent]);

  const refreshVersions = useCallback(async () => {
    try {
      const next = await listVeraStudioVersions(projectId, documentId);
      setVersions(next);
      setVersionError(false);
    } catch {
      setVersionError(true);
    }
  }, [documentId, projectId]);

  const refreshSuggestions = useCallback(
    async (preserveError = false) => {
      setSuggestionsLoading(true);
      try {
        const next = await listVeraStudioSuggestions(projectId, documentId);
        let nextError = preserveError;
        if (selectedSuggestion) {
          const preview = next.suggestions.find(
            (item) => item.id === selectedSuggestion.id,
          );
          if (!preview) {
            setSelectedSuggestion(null);
          } else if (
            !veraStudioSuggestionMatchesPreview(selectedSuggestion, preview)
          ) {
            setSelectedSuggestion(null);
            nextError = true;
          }
        }
        setSuggestionPage(next);
        setSuggestionError(nextError);
      } catch {
        setSuggestionPage(null);
        setSelectedSuggestion(null);
        setSuggestionError(true);
      } finally {
        setSuggestionsLoading(false);
      }
    },
    [documentId, projectId, selectedSuggestion],
  );

  const save = useCallback(async () => {
    if (
      !document ||
      saving ||
      restoring ||
      importing ||
      exporting ||
      historical ||
      !dirty
    ) {
      return;
    }
    setSaving(true);
    setErrorKind(null);
    try {
      const next = await saveVeraStudioDocument(projectId, documentId, {
        expected_version_id: document.current_version_id,
        content: workingContent,
        source: "user_upload",
        citation_anchor_ids: document.citation_anchors.map(
          (anchor) => anchor.id,
        ),
      });
      applyCurrent(next);
      await Promise.all([refreshVersions(), refreshSuggestions()]);
    } catch (error) {
      setErrorKind(
        isOfflineFailure(error)
          ? "offline"
          : isVersionConflict(error)
            ? "conflict"
            : "save",
      );
    } finally {
      setSaving(false);
    }
  }, [
    applyCurrent,
    dirty,
    document,
    documentId,
    exporting,
    historical,
    importing,
    projectId,
    refreshVersions,
    refreshSuggestions,
    restoring,
    saving,
    workingContent,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [save]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const openVersion = useCallback(
    async (versionId: string) => {
      if (saving || restoring || importing || exporting) return;
      if (dirty) {
        setErrorKind("versions");
        return;
      }
      if (versionId === document?.current_version_id) {
        setHistorical(null);
        setErrorKind(null);
        return;
      }
      historyControllerRef.current?.abort();
      const controller = new AbortController();
      historyControllerRef.current = controller;
      setHistoryLoadingId(versionId);
      setErrorKind(null);
      try {
        const next = await getVeraStudioDocument(
          projectId,
          documentId,
          versionId,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (
          next.project_id !== projectId ||
          next.document_id !== documentId ||
          next.version.id !== versionId
        ) {
          throw new VeraApiError({
            status: 200,
            code: "INVALID_RESPONSE",
            message: "The Vera API returned the wrong Studio version.",
          });
        }
        setHistorical(next);
      } catch (error) {
        if (!controller.signal.aborted) {
          setErrorKind(isOfflineFailure(error) ? "offline" : "versions");
        }
      } finally {
        if (!controller.signal.aborted) setHistoryLoadingId(null);
      }
    },
    [
      dirty,
      document?.current_version_id,
      documentId,
      exporting,
      importing,
      projectId,
      restoring,
      saving,
    ],
  );

  const restoreHistorical = useCallback(async () => {
    if (
      !document ||
      !historical ||
      restoring ||
      importing ||
      exporting ||
      dirty
    ) {
      return;
    }
    setRestoring(true);
    setErrorKind(null);
    try {
      const next = await restoreVeraStudioVersion(
        projectId,
        documentId,
        historical.version.id,
        { expected_current_version_id: document.current_version_id },
      );
      applyCurrent(next);
      await Promise.all([refreshVersions(), refreshSuggestions()]);
    } catch (error) {
      setErrorKind(
        isOfflineFailure(error)
          ? "offline"
          : isVersionConflict(error)
            ? "conflict"
            : "restore",
      );
    } finally {
      setRestoring(false);
    }
  }, [
    applyCurrent,
    dirty,
    document,
    documentId,
    exporting,
    historical,
    importing,
    projectId,
    refreshVersions,
    refreshSuggestions,
    restoring,
  ]);

  const reloadLatest = useCallback(async () => {
    setReloadConfirmOpen(false);
    setLoading(true);
    try {
      const next = await getVeraStudioDocument(projectId, documentId);
      applyCurrent(next);
      setErrorKind(null);
      await Promise.all([refreshVersions(), refreshSuggestions()]);
    } catch (error) {
      setErrorKind(isOfflineFailure(error) ? "offline" : "load");
    } finally {
      setLoading(false);
    }
  }, [
    applyCurrent,
    documentId,
    projectId,
    refreshSuggestions,
    refreshVersions,
  ]);

  const copyLocalDraft = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(workingContent);
    } catch {
      setErrorKind("clipboard");
    }
  }, [workingContent]);

  const openCitation = useCallback(
    async (anchor: VeraStudioCitationAnchorWire) => {
      sourceControllerRef.current?.abort();
      const controller = new AbortController();
      sourceControllerRef.current = controller;
      setSourceLoadingId(anchor.id);
      setSourceError(false);
      setResolvedCitation(null);
      try {
        const resolved = await resolveVeraProjectCitation(
          projectId,
          anchor,
          controller.signal,
        );
        if (!controller.signal.aborted) setResolvedCitation(resolved);
      } catch {
        if (!controller.signal.aborted) setSourceError(true);
      } finally {
        if (!controller.signal.aborted) setSourceLoadingId(null);
      }
    },
    [projectId],
  );

  const openSuggestion = useCallback(
    async (suggestionId: string) => {
      if (suggestionDecisionId !== null) return;
      if (selectedSuggestion?.id === suggestionId) {
        setSelectedSuggestion(null);
        return;
      }
      suggestionControllerRef.current?.abort();
      const controller = new AbortController();
      suggestionControllerRef.current = controller;
      setSuggestionLoadingId(suggestionId);
      setSuggestionError(false);
      try {
        const next = await getVeraStudioSuggestion(
          projectId,
          documentId,
          suggestionId,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (
          next.id !== suggestionId ||
          next.project_id !== projectId ||
          next.document_id !== documentId ||
          next.status !== "pending"
        ) {
          throw new VeraApiError({
            status: 200,
            code: "INVALID_RESPONSE",
            message: "The Vera API returned the wrong Studio suggestion.",
          });
        }
        const preview = suggestionPage?.suggestions.find(
          (item) => item.id === suggestionId,
        );
        if (!preview || !veraStudioSuggestionMatchesPreview(next, preview)) {
          throw new VeraApiError({
            status: 200,
            code: "INVALID_RESPONSE",
            message:
              "The Vera API returned a Studio suggestion detail that drifted from its preview.",
          });
        }
        setSelectedSuggestion(next);
      } catch {
        if (!controller.signal.aborted) {
          setSelectedSuggestion(null);
          setSuggestionError(true);
          void refreshSuggestions(true);
        }
      } finally {
        if (!controller.signal.aborted) setSuggestionLoadingId(null);
      }
    },
    [
      documentId,
      projectId,
      refreshSuggestions,
      selectedSuggestion?.id,
      suggestionPage?.suggestions,
      suggestionDecisionId,
    ],
  );

  const acceptSuggestion = useCallback(async () => {
    if (
      !document ||
      !selectedSuggestion ||
      selectedSuggestion.status !== "pending" ||
      selectedSuggestion.base_version_id !== document.current_version_id ||
      dirty ||
      historical ||
      suggestionDecisionId !== null ||
      saving ||
      restoring ||
      importing ||
      exporting
    ) {
      return;
    }
    const reviewedSuggestion = selectedSuggestion;
    const baseDocument = document;
    const suggestionId = reviewedSuggestion.id;
    setSuggestionDecisionId(suggestionId);
    setSuggestionDecisionAction("accept");
    setSuggestionError(false);
    setSuggestionAnnouncement(null);
    try {
      const accepted = await acceptVeraStudioSuggestion(projectId, documentId, {
        reviewedSuggestion,
        baseDocument,
      });
      applyCurrent(accepted.document);
      setSelectedSuggestion(null);
      setSuggestionAnnouncement(t("studio.suggestions.acceptedStatus"));
      await Promise.all([refreshVersions(), refreshSuggestions()]);
    } catch {
      setSuggestionError(true);
      const [currentResult] = await Promise.allSettled([
        getVeraStudioDocument(projectId, documentId),
        refreshVersions(),
        refreshSuggestions(true),
      ]);
      if (currentResult.status === "fulfilled") {
        try {
          applyCurrent(currentResult.value);
        } catch {
          // Keep the fail-closed suggestion error visible.
        }
      }
    } finally {
      setSuggestionDecisionId(null);
      setSuggestionDecisionAction(null);
      requestAnimationFrame(() => suggestionPanelRef.current?.focus());
    }
  }, [
    applyCurrent,
    dirty,
    document,
    documentId,
    exporting,
    historical,
    importing,
    projectId,
    refreshSuggestions,
    refreshVersions,
    restoring,
    saving,
    selectedSuggestion,
    suggestionDecisionId,
    t,
  ]);

  const rejectSuggestion = useCallback(async () => {
    if (!selectedSuggestion || suggestionDecisionId !== null) return;
    const suggestionId = selectedSuggestion.id;
    setSuggestionDecisionId(suggestionId);
    setSuggestionDecisionAction("reject");
    setSuggestionError(false);
    setSuggestionAnnouncement(null);
    try {
      await rejectVeraStudioSuggestion(projectId, documentId, suggestionId);
      setSelectedSuggestion(null);
      setSuggestionAnnouncement(t("studio.suggestions.rejectedStatus"));
      await refreshSuggestions();
    } catch {
      setSuggestionError(true);
      await refreshSuggestions(true);
    } finally {
      setSuggestionDecisionId(null);
      setSuggestionDecisionAction(null);
      requestAnimationFrame(() => suggestionPanelRef.current?.focus());
    }
  }, [
    documentId,
    projectId,
    refreshSuggestions,
    selectedSuggestion,
    suggestionDecisionId,
    t,
  ]);

  const canImportDocx =
    document?.capabilities.docx_import === true &&
    historical === null &&
    !dirty &&
    !saving &&
    !restoring &&
    !importing &&
    !exporting &&
    historyLoadingId === null &&
    errorKind !== "conflict";
  const canExportDocx =
    document?.capabilities.docx_export === true &&
    !saving &&
    !restoring &&
    !importing &&
    !exporting &&
    historyLoadingId === null;

  const importDocx = useCallback(async () => {
    if (!document || !pendingImportFile || !canImportDocx) return;
    const expectedVersionId = document.current_version_id;
    setImporting(true);
    setErrorKind(null);
    setDocxWarnings(null);
    try {
      const result = await importVeraStudioDocx(
        projectId,
        documentId,
        expectedVersionId,
        pendingImportFile,
      );
      applyCurrent(result.document);
      setDocxWarnings({ operation: "import", codes: result.warnings });
      await Promise.all([refreshVersions(), refreshSuggestions()]);
    } catch (error) {
      setErrorKind(
        isOfflineFailure(error)
          ? "offline"
          : isVersionConflict(error)
            ? "conflict"
            : "import",
      );
    } finally {
      setPendingImportFile(null);
      setImporting(false);
    }
  }, [
    applyCurrent,
    canImportDocx,
    document,
    documentId,
    pendingImportFile,
    projectId,
    refreshVersions,
    refreshSuggestions,
  ]);

  const exportDocx = useCallback(async () => {
    if (!document || !canExportDocx) return;
    const selectedVersionId = (historical ?? document).version.id;
    setExporting(true);
    setErrorKind(null);
    setDocxWarnings(null);
    try {
      const result = await exportVeraStudioDocx(
        projectId,
        documentId,
        selectedVersionId,
      );
      const url = URL.createObjectURL(result.blob);
      try {
        const anchor = window.document.createElement("a");
        anchor.href = url;
        anchor.download = result.filename;
        anchor.rel = "noopener";
        window.document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      setDocxWarnings({ operation: "export", codes: result.warningCodes });
    } catch (error) {
      setErrorKind(isOfflineFailure(error) ? "offline" : "export");
    } finally {
      setExporting(false);
    }
  }, [canExportDocx, document, documentId, historical, projectId]);

  if (loading && !document) {
    return (
      <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <ProjectSectionToolbar />
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t("common.status.loading")}
        </div>
      </div>
    );
  }

  if (!document) {
    return (
      <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <ProjectSectionToolbar />
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <AlertTriangle className="h-7 w-7 text-red-500" aria-hidden="true" />
          <p role="alert" className="max-w-lg text-sm text-red-700">
            {errorText ?? t("studio.errors.load")}
          </p>
          <button
            type="button"
            onClick={() => void loadCurrent()}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            {t("common.actions.retry")}
          </button>
        </div>
      </div>
    );
  }

  const visibleContent = historical?.content ?? workingContent;
  const visibleVersion = historical?.version ?? document.version;
  const versionItems = [...(versions?.versions ?? [])].sort(
    (left, right) => right.version_number - left.version_number,
  );

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <ProjectSectionToolbar />
      <main
        className="min-h-0 flex-1 overflow-y-auto bg-[#f7f8fa]"
        aria-labelledby="studio-title"
      >
        <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4 md:px-8 md:py-6">
          <header className="flex flex-col gap-3 rounded-2xl border border-white/80 bg-white/80 px-4 py-3 shadow-sm backdrop-blur-xl sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <button
                type="button"
                onClick={() => router.push(`/projects/${projectId}`)}
                aria-label={t("studio.back")}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-800"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              </button>
              <div className="min-w-0">
                <h1
                  id="studio-title"
                  className="truncate text-base font-semibold text-gray-950"
                >
                  {document.title}
                </h1>
                <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                  <span>
                    {historical
                      ? t("studio.historicalVersion", {
                          version: visibleVersion.version_number,
                        })
                      : t("studio.currentVersion", {
                          version: visibleVersion.version_number,
                        })}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span
                    aria-live="polite"
                    data-testid="studio-save-status"
                    data-state={saving ? "saving" : dirty ? "dirty" : "saved"}
                    className="inline-flex items-center gap-1"
                  >
                    {saving ? (
                      <Loader2
                        className="h-3 w-3 animate-spin"
                        aria-hidden="true"
                      />
                    ) : dirty ? (
                      <Clock3
                        className="h-3 w-3 text-amber-500"
                        aria-hidden="true"
                      />
                    ) : (
                      <Check
                        className="h-3 w-3 text-emerald-600"
                        aria-hidden="true"
                      />
                    )}
                    {saving
                      ? t("studio.saving")
                      : dirty
                        ? t("studio.unsaved")
                        : t("studio.saved")}
                  </span>
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <input
                ref={importInputRef}
                type="file"
                hidden
                tabIndex={-1}
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/octet-stream"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0] ?? null;
                  event.currentTarget.value = "";
                  if (file && canImportDocx) {
                    setPendingImportFile(file);
                    setErrorKind(null);
                  }
                }}
              />
              {document.capabilities.docx_import === true && !historical && (
                <button
                  type="button"
                  disabled={!canImportDocx}
                  onClick={() => importInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {importing ? (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <FileUp className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {importing
                    ? t("studio.docx.importing")
                    : t("studio.docx.import")}
                </button>
              )}
              {document.capabilities.docx_export === true && (
                <button
                  type="button"
                  disabled={!canExportDocx}
                  onClick={() => void exportDocx()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {exporting ? (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {exporting
                    ? t("studio.docx.exporting")
                    : t("studio.docx.export")}
                </button>
              )}
              {historical ? (
                <>
                  <button
                    type="button"
                    onClick={() => setHistorical(null)}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    {t("studio.current")}
                  </button>
                  <button
                    type="button"
                    disabled={restoring || importing || exporting || dirty}
                    onClick={() => void restoreHistorical()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-2 text-xs font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {restoring ? (
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {restoring ? t("studio.restoring") : t("studio.restore")}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={
                    !dirty || saving || restoring || importing || exporting
                  }
                  onClick={() => void save()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-2 text-xs font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Save className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {saving ? t("studio.saving") : t("studio.save")}
                </button>
              )}
            </div>
          </header>

          {dirty &&
            document.capabilities.docx_export === true &&
            !historical && (
              <p
                role="status"
                className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900"
              >
                {t("studio.docx.exportSavedOnly")}
              </p>
            )}

          {docxWarnings && docxWarnings.codes.length > 0 && (
            <section
              role="status"
              aria-live="polite"
              className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-950"
            >
              <h2 className="text-xs font-semibold">
                {docxWarnings.operation === "import"
                  ? t("studio.docx.importWarnings")
                  : t("studio.docx.exportWarnings")}
              </h2>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs leading-5">
                {docxWarnings.codes.map((code) => (
                  <li key={code}>{docxWarningText(code)}</li>
                ))}
              </ul>
            </section>
          )}

          {errorText && (
            <div
              role="alert"
              className={`flex flex-col gap-3 rounded-xl border px-4 py-3 text-sm sm:flex-row sm:items-center ${
                errorKind === "conflict"
                  ? "border-amber-200 bg-amber-50 text-amber-900"
                  : "border-red-200 bg-red-50 text-red-800"
              }`}
            >
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">{errorText}</span>
              {errorKind === "conflict" && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void copyLocalDraft()}
                    className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2.5 py-1.5 text-xs font-medium"
                  >
                    <Copy className="h-3 w-3" aria-hidden="true" />
                    {t("studio.copyLocal")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setReloadConfirmOpen(true)}
                    className="inline-flex items-center gap-1 rounded-md bg-amber-900 px-2.5 py-1.5 text-xs font-medium text-white"
                  >
                    <RefreshCw className="h-3 w-3" aria-hidden="true" />
                    {t("studio.reloadLatest")}
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="grid min-h-[36rem] gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <section
              className="min-h-[32rem] overflow-hidden"
              aria-label={t("studio.editorLabel")}
            >
              <VeraRichTextEditor
                value={visibleContent}
                onChange={
                  historical || importing || suggestionDecisionId !== null
                    ? undefined
                    : setWorkingContent
                }
                readOnly={
                  historical !== null ||
                  importing ||
                  suggestionDecisionId !== null
                }
                ariaLabel={t("studio.editorLabel")}
                maxLength={2_000_000}
              />
            </section>

            <aside
              className="grid content-start gap-4"
              aria-label={t("studio.detailsPanel")}
            >
              <section
                ref={suggestionPanelRef}
                tabIndex={-1}
                className="overflow-hidden rounded-2xl border border-gray-200 bg-white"
                aria-labelledby="studio-suggestions-title"
                data-testid="studio-suggestions-panel"
              >
                <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
                  <Sparkles
                    className="h-4 w-4 text-violet-500"
                    aria-hidden="true"
                  />
                  <h2
                    id="studio-suggestions-title"
                    className="text-sm font-semibold text-gray-900"
                  >
                    {t("studio.suggestions.title")}
                  </h2>
                  <span className="ml-auto text-xs text-gray-500">
                    {suggestionPage?.suggestions.length ?? 0}
                  </span>
                  {suggestionsLoading && (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin text-gray-400"
                      aria-hidden="true"
                    />
                  )}
                </div>
                <p className="sr-only" role="status" aria-live="polite">
                  {suggestionAnnouncement ?? ""}
                </p>
                {suggestionError && (
                  <div
                    role="alert"
                    className="flex items-center gap-2 border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700"
                  >
                    <span className="min-w-0 flex-1">
                      {t("studio.suggestions.error")}
                    </span>
                    <button
                      type="button"
                      onClick={() => void refreshSuggestions()}
                      aria-label={t("common.actions.retry")}
                    >
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                )}
                {(suggestionPage?.suggestions.length ?? 0) === 0 ? (
                  suggestionError ? null : (
                    <p className="px-4 py-6 text-center text-xs text-gray-500">
                      {suggestionsLoading
                        ? t("common.status.loading")
                        : t("studio.suggestions.empty")}
                    </p>
                  )
                ) : (
                  <ol className="max-h-[36rem] space-y-2 overflow-y-auto p-2">
                    {suggestionPage?.suggestions.map((preview) => {
                      const exact =
                        selectedSuggestion?.id === preview.id
                          ? selectedSuggestion
                          : null;
                      const stale =
                        preview.base_version_id !== document.current_version_id;
                      const deciding = suggestionDecisionId === preview.id;
                      const acceptDisabled =
                        exact === null ||
                        stale ||
                        dirty ||
                        historical !== null ||
                        deciding ||
                        suggestionDecisionId !== null ||
                        saving ||
                        restoring ||
                        importing ||
                        exporting;
                      return (
                        <li
                          key={preview.id}
                          className="overflow-hidden rounded-xl border border-gray-100 bg-gray-50"
                        >
                          <button
                            type="button"
                            onClick={() => void openSuggestion(preview.id)}
                            disabled={
                              suggestionDecisionId !== null ||
                              suggestionLoadingId !== null
                            }
                            aria-expanded={exact !== null}
                            aria-controls={`studio-suggestion-detail-${preview.id}`}
                            data-testid={`studio-suggestion-open-${preview.id}`}
                            className="w-full p-3 text-left disabled:cursor-wait disabled:opacity-60"
                          >
                            <span className="block text-xs font-medium text-gray-800">
                              {preview.summary}
                            </span>
                            <span className="mt-1 block font-mono text-[10px] text-gray-500">
                              {t("studio.suggestions.range", {
                                start: preview.start_offset,
                                end: preview.end_offset,
                              })}
                            </span>
                            <span className="mt-2 block max-h-24 overflow-hidden whitespace-pre-wrap break-words rounded-lg bg-white px-2 py-1.5 font-mono text-[11px] leading-5 text-gray-500">
                              {preview.context_before}
                              <del className="bg-red-100 text-red-800 no-underline line-through">
                                {preview.deleted_preview || "∅"}
                                {preview.deleted_truncated ? "…" : ""}
                              </del>
                              <ins className="bg-emerald-100 text-emerald-800 no-underline">
                                {preview.inserted_preview || "∅"}
                                {preview.inserted_truncated ? "…" : ""}
                              </ins>
                              {preview.context_after}
                            </span>
                            {suggestionLoadingId === preview.id && (
                              <span className="mt-2 inline-flex items-center gap-1 text-[10px] text-gray-500">
                                <Loader2
                                  className="h-3 w-3 animate-spin"
                                  aria-hidden="true"
                                />
                                {t("studio.suggestions.loadingDetail")}
                              </span>
                            )}
                          </button>

                          {exact && (
                            <div
                              id={`studio-suggestion-detail-${preview.id}`}
                              className="border-t border-gray-200 bg-white p-3"
                            >
                              <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
                                {t("studio.suggestions.exactDiff")}
                              </p>
                              <div
                                className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-gray-100 bg-gray-50 p-2 font-mono text-xs leading-5 text-gray-700"
                                data-testid="studio-suggestion-exact-diff"
                              >
                                {exact.context_before}
                                <del className="bg-red-100 text-red-800 decoration-red-500">
                                  {exact.deleted_text || "∅"}
                                </del>
                                <ins className="bg-emerald-100 text-emerald-800 no-underline">
                                  {exact.inserted_text || "∅"}
                                </ins>
                                {exact.context_after}
                              </div>
                              {(dirty || historical || stale) && (
                                <p className="mt-2 text-[11px] leading-4 text-amber-700">
                                  {stale
                                    ? t("studio.suggestions.stale")
                                    : dirty
                                      ? t("studio.suggestions.unsavedBlocked")
                                      : t(
                                          "studio.suggestions.historicalBlocked",
                                        )}
                                </p>
                              )}
                              <div className="mt-3 flex gap-2">
                                <button
                                  type="button"
                                  disabled={acceptDisabled}
                                  onClick={() => void acceptSuggestion()}
                                  data-testid="studio-suggestion-accept"
                                  className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-gray-900 px-2 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  {deciding &&
                                  suggestionDecisionAction === "accept" ? (
                                    <Loader2
                                      className="h-3.5 w-3.5 animate-spin"
                                      aria-hidden="true"
                                    />
                                  ) : (
                                    <Check
                                      className="h-3.5 w-3.5"
                                      aria-hidden="true"
                                    />
                                  )}
                                  {t("studio.suggestions.accept")}
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    deciding || suggestionDecisionId !== null
                                  }
                                  onClick={() => void rejectSuggestion()}
                                  data-testid="studio-suggestion-reject"
                                  className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs font-medium text-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  {deciding &&
                                  suggestionDecisionAction === "reject" ? (
                                    <Loader2
                                      className="h-3.5 w-3.5 animate-spin"
                                      aria-hidden="true"
                                    />
                                  ) : (
                                    <X
                                      className="h-3.5 w-3.5"
                                      aria-hidden="true"
                                    />
                                  )}
                                  {t("studio.suggestions.reject")}
                                </button>
                              </div>
                            </div>
                          )}
                        </li>
                      );
                    })}
                    {suggestionPage?.has_more && (
                      <li className="px-2 py-1 text-[10px] leading-4 text-gray-500">
                        {t("studio.suggestions.more")}
                      </li>
                    )}
                  </ol>
                )}
              </section>

              <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
                <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
                  <History
                    className="h-4 w-4 text-gray-500"
                    aria-hidden="true"
                  />
                  <h2 className="text-sm font-semibold text-gray-900">
                    {t("studio.versions")}
                  </h2>
                  {versionError && (
                    <button
                      type="button"
                      onClick={() => void refreshVersions()}
                      aria-label={t("common.actions.retry")}
                      className="ml-auto text-red-600 hover:text-red-800"
                    >
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>
                {versionError && (
                  <p
                    role="alert"
                    className="border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700"
                  >
                    {t("studio.errors.versions")}
                  </p>
                )}
                <ol className="max-h-72 overflow-y-auto p-2">
                  {versionItems.map((version) => {
                    const current = version.id === document.current_version_id;
                    const selected = version.id === visibleVersion.id;
                    return (
                      <li key={version.id}>
                        <button
                          type="button"
                          disabled={
                            historyLoadingId !== null ||
                            saving ||
                            restoring ||
                            importing ||
                            exporting ||
                            (dirty && !current)
                          }
                          aria-current={selected ? "true" : undefined}
                          aria-label={t("studio.viewVersion", {
                            version: version.version_number,
                          })}
                          onClick={() => void openVersion(version.id)}
                          className={`flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                            selected ? "bg-gray-100" : "hover:bg-gray-50"
                          }`}
                        >
                          {historyLoadingId === version.id ? (
                            <Loader2
                              className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-gray-400"
                              aria-hidden="true"
                            />
                          ) : (
                            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded bg-gray-100 px-1 text-[10px] font-semibold text-gray-600">
                              v{version.version_number}
                            </span>
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1 text-xs font-medium text-gray-800">
                              {version.source}
                              {current && (
                                <span className="rounded bg-emerald-50 px-1 text-[10px] text-emerald-700">
                                  {t("studio.current")}
                                </span>
                              )}
                            </span>
                            <span className="mt-0.5 block text-[11px] text-gray-500">
                              {formatDate(version.created_at)} ·{" "}
                              {formatFileSize(version.size_bytes)}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </section>

              <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
                <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
                  <Quote className="h-4 w-4 text-gray-500" aria-hidden="true" />
                  <h2 className="text-sm font-semibold text-gray-900">
                    {t("studio.citations")}
                  </h2>
                  <span className="ml-auto text-xs text-gray-500">
                    {displayDocument?.citation_anchors.length ?? 0}
                  </span>
                </div>
                {displayDocument &&
                displayDocument.citation_anchors.length > 0 ? (
                  <>
                    {sourceError && (
                      <p
                        role="alert"
                        className="border-b border-red-100 bg-red-50 px-4 py-2 text-xs leading-5 text-red-700"
                      >
                        {t("studio.sourceViewer.error")}
                      </p>
                    )}
                    <ol className="max-h-96 space-y-2 overflow-y-auto p-3">
                      {displayDocument.citation_anchors.map((anchor) => (
                        <li key={anchor.id}>
                          <button
                            type="button"
                            disabled={sourceLoadingId !== null}
                            onClick={() => void openCitation(anchor)}
                            aria-label={t("studio.sourceViewer.openCitation")}
                            data-testid={`studio-citation-open-${anchor.id}`}
                            className="group w-full rounded-xl bg-gray-50 p-3 text-left transition-colors hover:bg-gray-100 disabled:cursor-wait disabled:opacity-60"
                          >
                            <p className="text-xs leading-5 text-gray-700">
                              “{anchor.exact_quote}”
                            </p>
                            <span className="mt-2 flex items-center gap-1.5 text-[10px] text-gray-500">
                              {sourceLoadingId === anchor.id ? (
                                <Loader2
                                  className="h-3 w-3 shrink-0 animate-spin"
                                  aria-hidden="true"
                                />
                              ) : (
                                <ScanSearch
                                  className="h-3 w-3 shrink-0 transition-colors group-hover:text-gray-600"
                                  aria-hidden="true"
                                />
                              )}
                              <span
                                className="min-w-0 flex-1 truncate font-mono"
                                title={anchor.snapshot_id}
                              >
                                {t("studio.sourceSnapshot", {
                                  id: shortId(anchor.snapshot_id),
                                })}
                              </span>
                              <span className="shrink-0 font-sans font-medium text-gray-500">
                                {t("studio.sourceViewer.open")}
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  </>
                ) : (
                  <p className="px-4 py-6 text-center text-xs text-gray-500">
                    {t("studio.noCitations")}
                  </p>
                )}
              </section>
            </aside>
          </div>
        </div>
      </main>

      <ConfirmPopup
        open={pendingImportFile !== null}
        title={t("studio.docx.confirm.title")}
        message={t("studio.docx.confirm.body", {
          name: pendingImportFile?.name ?? "",
        })}
        confirmLabel={t("studio.docx.confirm.action")}
        confirmStatus={importing ? "loading" : "idle"}
        confirmDisabled={!canImportDocx}
        cancelLabel={t("common.actions.cancel")}
        cancelDisabled={importing}
        onCancel={() => {
          if (!importing) setPendingImportFile(null);
        }}
        onConfirm={() => void importDocx()}
      />

      <ConfirmPopup
        open={reloadConfirmOpen}
        title={t("studio.reloadConfirm.title")}
        message={t("studio.reloadConfirm.body")}
        confirmLabel={t("studio.reloadConfirm.action")}
        confirmStatus={loading ? "loading" : "idle"}
        cancelLabel={t("common.actions.cancel")}
        cancelDisabled={loading}
        onCancel={() => {
          if (!loading) setReloadConfirmOpen(false);
        }}
        onConfirm={() => void reloadLatest()}
      />

      {resolvedCitation && (
        <ProjectCitationSourceViewer
          source={{ kind: "studio_anchor", citation: resolvedCitation }}
          onClose={() => setResolvedCitation(null)}
        />
      )}
    </div>
  );
}
