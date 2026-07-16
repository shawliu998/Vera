"use client";

import {
  AlertCircle,
  Download,
  ExternalLink,
  FilePenLine,
  FileText,
  LayoutTemplate,
  ListTree,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ConfirmPopup } from "@/app/components/shared/ConfirmPopup";
import { useWorkspaceRoutes } from "@/app/components/projects/WorkspaceRouteAdapter";
import { useI18n } from "@/app/i18n";
import { deleteVeraDocument, VeraApiError } from "@/app/lib/veraApi";
import {
  createVeraStudioDocument,
  createVeraStudioDraftFromTemplate,
  exportVeraStudioDocx,
  getVeraStudioTemplate,
  listVeraStudioDrafts,
  listVeraStudioTemplates,
  VERA_STUDIO_DOCUMENT_TYPES,
  type VeraStudioDocumentType,
  type VeraStudioDraftListItemWire,
  type VeraStudioTemplateSummaryWire,
  type VeraStudioTemplateWire,
} from "@/app/lib/veraDocumentStudioApi";
import { useMatterWorkspace } from "@/features/matter-overview/MatterWorkspaceShell";
import { cn } from "@/lib/utils";

interface MatterDraftsViewProps {
  projectId: string;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    window.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export function MatterDraftsView({ projectId }: MatterDraftsViewProps) {
  const router = useRouter();
  const routes = useWorkspaceRoutes();
  const { matter } = useMatterWorkspace();
  const { errorMessage, formatDate, formatNumber, t } = useI18n();
  const [items, setItems] = useState<VeraStudioDraftListItemWire[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [actionFailures, setActionFailures] = useState<Record<string, string>>(
    {},
  );
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [documentType, setDocumentType] = useState<VeraStudioDocumentType>(
    "general_legal_document",
  );
  const [templates, setTemplates] = useState<VeraStudioTemplateSummaryWire[]>(
    [],
  );
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesFailure, setTemplatesFailure] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [selectedTemplate, setSelectedTemplate] =
    useState<VeraStudioTemplateWire | null>(null);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateFailure, setTemplateFailure] = useState<string | null>(null);
  const [createFailure, setCreateFailure] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] =
    useState<VeraStudioDraftListItemWire | null>(null);
  const readOnly = matter.project.status !== "active";

  const loadFirstPage = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadFailure(null);
      try {
        const page = await listVeraStudioDrafts(
          projectId,
          { limit: 100 },
          signal,
        );
        if (!signal?.aborted) {
          setItems(page.items);
          setNextCursor(page.next_cursor);
        }
      } catch (cause) {
        if (!signal?.aborted) {
          setItems([]);
          setNextCursor(null);
          setLoadFailure(errorMessage(cause as Error));
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [errorMessage, projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadFirstPage(controller.signal);
    return () => controller.abort();
  }, [loadFirstPage]);

  const loadTemplates = useCallback(
    async (signal?: AbortSignal) => {
      setTemplatesLoading(true);
      setTemplatesFailure(null);
      try {
        const result = await listVeraStudioTemplates(projectId, signal);
        if (!signal?.aborted) {
          setTemplates(result.items);
          setSelectedTemplateId((current) =>
            current &&
            !result.items.some((template) => template.template_id === current)
              ? ""
              : current,
          );
        }
      } catch (cause) {
        if (!signal?.aborted) {
          setTemplates([]);
          setTemplatesFailure(errorMessage(cause as Error));
        }
      } finally {
        if (!signal?.aborted) setTemplatesLoading(false);
      }
    },
    [errorMessage, projectId],
  );

  useEffect(() => {
    if (!showCreate || readOnly) return;
    const controller = new AbortController();
    void loadTemplates(controller.signal);
    return () => controller.abort();
  }, [loadTemplates, readOnly, showCreate]);

  const loadSelectedTemplate = useCallback(
    async (templateId: string, signal?: AbortSignal) => {
      setTemplateLoading(true);
      setTemplateFailure(null);
      setSelectedTemplate(null);
      try {
        const template = await getVeraStudioTemplate(
          projectId,
          templateId,
          signal,
        );
        if (!signal?.aborted) setSelectedTemplate(template);
      } catch (cause) {
        if (!signal?.aborted) {
          setTemplateFailure(errorMessage(cause as Error));
        }
      } finally {
        if (!signal?.aborted) setTemplateLoading(false);
      }
    },
    [errorMessage, projectId],
  );

  useEffect(() => {
    if (!showCreate || readOnly || !selectedTemplateId) {
      setSelectedTemplate(null);
      setTemplateFailure(null);
      setTemplateLoading(false);
      return;
    }
    const controller = new AbortController();
    void loadSelectedTemplate(selectedTemplateId, controller.signal);
    return () => controller.abort();
  }, [loadSelectedTemplate, readOnly, selectedTemplateId, showCreate]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadFailure(null);
    try {
      const page = await listVeraStudioDrafts(projectId, {
        cursor: nextCursor,
        limit: 100,
      });
      const existing = new Set(items.map((item) => item.draft_id));
      if (
        page.items.some((item) => existing.has(item.draft_id)) ||
        page.next_cursor === nextCursor
      ) {
        throw new VeraApiError({
          status: 200,
          code: "INVALID_RESPONSE",
          message: "The Vera API returned invalid Studio draft pagination.",
        });
      }
      setItems((current) => {
        return [...current, ...page.items];
      });
      setNextCursor(page.next_cursor);
    } catch (cause) {
      setLoadFailure(errorMessage(cause as Error));
    } finally {
      setLoadingMore(false);
    }
  };

  const createDraft = async () => {
    const title = draftTitle.trim();
    if (
      !title ||
      readOnly ||
      busyAction ||
      (selectedTemplateId &&
        selectedTemplate?.template_id !== selectedTemplateId)
    ) {
      return;
    }
    setBusyAction("create");
    setCreateFailure(null);
    try {
      const document = selectedTemplateId
        ? (
            await createVeraStudioDraftFromTemplate(
              projectId,
              selectedTemplateId,
              { title },
            )
          ).document
        : await createVeraStudioDocument(projectId, {
            title,
            document_type: documentType,
          });
      router.push(routes.documentStudioHref(projectId, document.document_id));
    } catch (cause) {
      setCreateFailure(errorMessage(cause as Error));
    } finally {
      setBusyAction(null);
    }
  };

  const exportDraft = async (draft: VeraStudioDraftListItemWire) => {
    const key = `export:${draft.draft_id}`;
    if (busyAction) return;
    setBusyAction(key);
    setActionFailures((current) => {
      const next = { ...current };
      delete next[draft.draft_id];
      return next;
    });
    try {
      const result = await exportVeraStudioDocx(
        projectId,
        draft.draft_id,
        draft.current_version_id,
      );
      downloadBlob(result.blob, result.filename);
    } catch (cause) {
      setActionFailures((current) => ({
        ...current,
        [draft.draft_id]: errorMessage(cause as Error),
      }));
    } finally {
      setBusyAction(null);
    }
  };

  const deleteDraft = async (draft: VeraStudioDraftListItemWire) => {
    const key = `delete:${draft.draft_id}`;
    if (readOnly || busyAction) return;
    setBusyAction(key);
    setActionFailures((current) => {
      const next = { ...current };
      delete next[draft.draft_id];
      return next;
    });
    try {
      await deleteVeraDocument(draft.draft_id, { projectId });
      setItems((current) =>
        current.filter((item) => item.draft_id !== draft.draft_id),
      );
      setPendingDelete(null);
    } catch (cause) {
      setActionFailures((current) => ({
        ...current,
        [draft.draft_id]: errorMessage(cause as Error),
      }));
      setPendingDelete(null);
    } finally {
      setBusyAction(null);
    }
  };

  const selectedTemplateSummary = templates.find(
    (template) => template.template_id === selectedTemplateId,
  );
  const createDisabled =
    !draftTitle.trim() ||
    busyAction !== null ||
    (selectedTemplateId !== "" &&
      (templateLoading ||
        selectedTemplate?.template_id !== selectedTemplateId));

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-gray-500">
              <FilePenLine className="h-4 w-4" aria-hidden="true" />
              {t("matters.drafts.eyebrow")}
            </div>
            <h1 className="mt-1 font-serif text-2xl text-gray-950 sm:text-3xl">
              {t("matters.drafts.title")}
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-gray-600">
              {t("matters.drafts.subtitle")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setShowCreate((current) => !current);
              setCreateFailure(null);
            }}
            disabled={readOnly}
            className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-full bg-gray-950 px-4 text-sm font-medium text-white shadow-sm transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {showCreate ? (
              <X className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Plus className="h-4 w-4" aria-hidden="true" />
            )}
            {showCreate
              ? t("common.actions.close")
              : t("matters.drafts.newDraft")}
          </button>
        </header>

        {readOnly && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {t("matters.drafts.readOnly")}
          </div>
        )}

        {showCreate && !readOnly && (
          <form
            className="grid gap-5 rounded-2xl border border-white/80 bg-white/75 p-4 shadow-sm backdrop-blur-xl sm:p-5"
            onSubmit={(event) => {
              event.preventDefault();
              void createDraft();
            }}
          >
            <div className="flex items-start gap-3">
              <span className="rounded-xl bg-gray-100 p-2 text-gray-700">
                <LayoutTemplate className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <h2 className="font-medium text-gray-950">
                  {t("matters.drafts.createTitle")}
                </h2>
                <p className="mt-0.5 text-sm text-gray-600">
                  {t("matters.drafts.createBody")}
                </p>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid min-w-0 gap-1.5 text-sm font-medium text-gray-800">
                <span className="flex items-center gap-2">
                  {t("matters.drafts.startingPointLabel")}
                  {templatesLoading && (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin text-gray-400"
                      aria-hidden="true"
                    />
                  )}
                </span>
                <select
                  value={selectedTemplateId}
                  onChange={(event) => {
                    setSelectedTemplateId(event.target.value);
                    setCreateFailure(null);
                  }}
                  className="h-10 min-w-0 rounded-xl border border-gray-200 bg-white px-3 font-normal text-gray-950 outline-none transition focus:border-gray-400 focus:ring-2 focus:ring-gray-900/10"
                >
                  <option value="">{t("matters.drafts.blankDraft")}</option>
                  {templates.map((template) => (
                    <option
                      key={template.template_id}
                      value={template.template_id}
                    >
                      {template.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid min-w-0 gap-1.5 text-sm font-medium text-gray-800">
                {t("matters.drafts.titleLabel")}
                <input
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  maxLength={240}
                  autoFocus
                  placeholder={t("matters.drafts.titlePlaceholder")}
                  className="h-10 min-w-0 rounded-xl border border-gray-200 bg-white px-3 font-normal text-gray-950 outline-none transition focus:border-gray-400 focus:ring-2 focus:ring-gray-900/10"
                />
              </label>
            </div>

            {templatesFailure && (
              <div
                role="alert"
                className="flex flex-col gap-2 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700 sm:flex-row sm:items-center sm:justify-between"
              >
                <span>{templatesFailure}</span>
                <button
                  type="button"
                  onClick={() => void loadTemplates()}
                  disabled={templatesLoading}
                  className="inline-flex shrink-0 items-center gap-1.5 self-start font-medium sm:self-auto"
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("common.actions.retry")}
                </button>
              </div>
            )}

            {!selectedTemplateId ? (
              <label className="grid min-w-0 gap-1.5 text-sm font-medium text-gray-800 md:max-w-md">
                {t("matters.drafts.typeLabel")}
                <select
                  value={documentType}
                  onChange={(event) =>
                    setDocumentType(
                      event.target.value as VeraStudioDocumentType,
                    )
                  }
                  className="h-10 min-w-0 rounded-xl border border-gray-200 bg-white px-3 font-normal text-gray-950 outline-none transition focus:border-gray-400 focus:ring-2 focus:ring-gray-900/10"
                >
                  {VERA_STUDIO_DOCUMENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(`matters.drafts.types.${type}`)}
                    </option>
                  ))}
                </select>
              </label>
            ) : templateLoading ? (
              <div
                role="status"
                className="flex min-h-28 items-center justify-center gap-2 rounded-xl border border-gray-100 bg-gray-50 text-sm text-gray-500"
              >
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t("matters.drafts.templateLoading")}
              </div>
            ) : templateFailure ? (
              <div className="rounded-xl border border-red-100 bg-red-50 p-3 text-sm text-red-700">
                <p role="alert">{templateFailure}</p>
                <button
                  type="button"
                  onClick={() => void loadSelectedTemplate(selectedTemplateId)}
                  className="mt-2 inline-flex items-center gap-1.5 font-medium"
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("common.actions.retry")}
                </button>
              </div>
            ) : selectedTemplate?.template_id === selectedTemplateId ? (
              <section
                aria-label={t("matters.drafts.planPreview")}
                className="rounded-xl border border-gray-200 bg-gray-50/80 p-3 sm:p-4"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium text-gray-950">
                        {selectedTemplate.title}
                      </h3>
                      <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-gray-600">
                        {t(
                          `matters.drafts.templateScopes.${selectedTemplate.scope}`,
                        )}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-gray-600">
                      {selectedTemplate.description}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-gray-950 px-2.5 py-1 text-xs font-medium text-white">
                    {t(
                      `matters.drafts.types.${selectedTemplate.document_type}`,
                    )}
                  </span>
                </div>
                <div className="mt-4 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-gray-500">
                  <ListTree className="h-4 w-4" aria-hidden="true" />
                  {t("matters.drafts.planSections", {
                    count: selectedTemplate.plan.sections.length,
                  })}
                </div>
                <ol className="mt-2 grid gap-2 lg:grid-cols-2">
                  {selectedTemplate.plan.sections.map((section, index) => (
                    <li
                      key={section.id}
                      className="min-w-0 rounded-lg border border-gray-200 bg-white p-3"
                    >
                      <div className="flex items-start gap-2">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[11px] font-semibold text-gray-600">
                          {index + 1}
                        </span>
                        <div className="min-w-0">
                          <h4 className="text-sm font-medium text-gray-900">
                            {section.heading}
                          </h4>
                          <p className="mt-1 text-xs leading-5 text-gray-600">
                            {section.purpose}
                          </p>
                          {section.required_sources.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {section.required_sources.map(
                                (source, sourceIndex) => (
                                  <span
                                    key={`${section.id}:${sourceIndex}:${source}`}
                                    className="rounded-md bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700"
                                  >
                                    {source}
                                  </span>
                                ),
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            ) : selectedTemplateSummary ? (
              <div className="rounded-xl border border-gray-100 bg-gray-50 p-3 text-sm text-gray-600">
                {selectedTemplateSummary.description}
              </div>
            ) : null}

            <div className="flex flex-col gap-3 border-t border-gray-100 pt-4 sm:flex-row sm:items-center sm:justify-end">
              <button
                type="submit"
                disabled={createDisabled}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-gray-950 px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busyAction === "create" && (
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                )}
                {t("matters.drafts.create")}
              </button>
            </div>
            {createFailure && (
              <p role="alert" className="text-sm text-red-700">
                {createFailure}
              </p>
            )}
          </form>
        )}

        {loading ? (
          <div className="flex min-h-64 items-center justify-center gap-2 rounded-2xl border border-white/80 bg-white/60 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t("common.status.loading")}
          </div>
        ) : loadFailure && items.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-red-100 bg-white/70 px-6 text-center">
            <AlertCircle className="h-7 w-7 text-red-500" aria-hidden="true" />
            <h2 className="mt-3 font-medium text-gray-950">
              {t("matters.drafts.loadError")}
            </h2>
            <p role="alert" className="mt-1 max-w-lg text-sm text-red-700">
              {loadFailure}
            </p>
            <button
              type="button"
              onClick={() => void loadFirstPage()}
              className="mt-4 inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-800"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              {t("common.actions.retry")}
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-white/55 px-6 text-center">
            <FileText className="h-8 w-8 text-gray-400" aria-hidden="true" />
            <h2 className="mt-3 font-serif text-xl text-gray-950">
              {t("matters.drafts.emptyTitle")}
            </h2>
            <p className="mt-1 max-w-lg text-sm text-gray-600">
              {t("matters.drafts.emptyBody")}
            </p>
          </div>
        ) : (
          <section
            aria-label={t("matters.drafts.listLabel")}
            className="grid gap-3"
          >
            {items.map((draft) => {
              const exporting = busyAction === `export:${draft.draft_id}`;
              const deleting = busyAction === `delete:${draft.draft_id}`;
              return (
                <article
                  key={draft.draft_id}
                  className="rounded-2xl border border-white/80 bg-white/75 p-4 shadow-sm backdrop-blur-xl sm:p-5"
                >
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="min-w-0 truncate font-serif text-lg text-gray-950">
                          {draft.title}
                        </h2>
                        <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-700">
                          {t(`matters.drafts.types.${draft.document_type}`)}
                        </span>
                        <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700">
                          {t(`matters.drafts.origins.${draft.origin_type}`)}
                        </span>
                      </div>
                      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-gray-600 sm:grid-cols-4">
                        <div>
                          <dt className="text-gray-400">
                            {t("matters.drafts.fields.version")}
                          </dt>
                          <dd className="mt-0.5 font-medium text-gray-800">
                            v{draft.current_version_number}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-gray-400">
                            {t("matters.drafts.fields.sources")}
                          </dt>
                          <dd className="mt-0.5 font-medium text-gray-800">
                            {formatNumber(draft.source_count)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-gray-400">
                            {t("matters.drafts.fields.suggestions")}
                          </dt>
                          <dd className="mt-0.5 font-medium text-gray-800">
                            {formatNumber(draft.pending_suggestion_count)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-gray-400">
                            {t("common.fields.updatedAt")}
                          </dt>
                          <dd className="mt-0.5 font-medium text-gray-800">
                            {formatDate(draft.updated_at, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </dd>
                        </div>
                      </dl>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
                      <button
                        type="button"
                        onClick={() =>
                          router.push(
                            routes.documentStudioHref(
                              projectId,
                              draft.draft_id,
                            ),
                          )
                        }
                        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl bg-gray-950 px-3 text-xs font-medium text-white"
                      >
                        <ExternalLink
                          className="h-3.5 w-3.5"
                          aria-hidden="true"
                        />
                        {t("common.actions.open")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void exportDraft(draft)}
                        disabled={busyAction !== null}
                        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 text-xs font-medium text-gray-800 disabled:opacity-40"
                      >
                        {exporting ? (
                          <Loader2
                            className="h-3.5 w-3.5 animate-spin"
                            aria-hidden="true"
                          />
                        ) : (
                          <Download
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                          />
                        )}
                        {t("matters.drafts.exportDocx")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDelete(draft)}
                        disabled={readOnly || busyAction !== null}
                        aria-label={t("matters.drafts.deleteLabel", {
                          title: draft.title,
                        })}
                        className="col-span-2 inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-red-100 bg-red-50 px-3 text-xs font-medium text-red-700 disabled:opacity-40 sm:col-auto"
                      >
                        {deleting ? (
                          <Loader2
                            className="h-3.5 w-3.5 animate-spin"
                            aria-hidden="true"
                          />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        {t("common.actions.delete")}
                      </button>
                    </div>
                  </div>
                  {actionFailures[draft.draft_id] && (
                    <div
                      role="alert"
                      className="mt-3 flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700"
                    >
                      <AlertCircle
                        className="mt-0.5 h-3.5 w-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      <span>{actionFailures[draft.draft_id]}</span>
                    </div>
                  )}
                </article>
              );
            })}
          </section>
        )}

        {loadFailure && items.length > 0 && (
          <div
            role="alert"
            className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {loadFailure}
          </div>
        )}
        {nextCursor && (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className={cn(
              "mx-auto inline-flex h-9 items-center justify-center gap-2 rounded-full border border-gray-200 bg-white px-5 text-sm font-medium text-gray-800",
              loadingMore && "cursor-not-allowed opacity-50",
            )}
          >
            {loadingMore && (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            {t("matters.drafts.loadMore")}
          </button>
        )}
      </div>

      <ConfirmPopup
        open={pendingDelete !== null}
        title={t("matters.drafts.deleteConfirm.title")}
        message={
          pendingDelete
            ? t("matters.drafts.deleteConfirm.body", {
                title: pendingDelete.title,
              })
            : undefined
        }
        confirmLabel={t("common.actions.delete")}
        confirmStatus={
          pendingDelete && busyAction === `delete:${pendingDelete.draft_id}`
            ? "loading"
            : "idle"
        }
        cancelDisabled={busyAction?.startsWith("delete:") ?? false}
        onCancel={() => {
          if (!busyAction?.startsWith("delete:")) setPendingDelete(null);
        }}
        onConfirm={() => {
          if (pendingDelete) void deleteDraft(pendingDelete);
        }}
      />
    </main>
  );
}
