"use client";

import {
  AlertCircle,
  Download,
  ExternalLink,
  FilePenLine,
  FileText,
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
  exportVeraStudioDocx,
  listVeraStudioDrafts,
  VERA_STUDIO_DOCUMENT_TYPES,
  type VeraStudioDocumentType,
  type VeraStudioDraftListItemWire,
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
    if (!title || readOnly || busyAction) return;
    setBusyAction("create");
    setCreateFailure(null);
    try {
      const created = await createVeraStudioDocument(projectId, {
        title,
        document_type: documentType,
      });
      router.push(routes.documentStudioHref(projectId, created.document_id));
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
            className="grid gap-4 rounded-2xl border border-white/80 bg-white/75 p-4 shadow-sm backdrop-blur-xl sm:grid-cols-[minmax(0,1fr)_minmax(220px,0.55fr)_auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              void createDraft();
            }}
          >
            <label className="grid gap-1.5 text-sm font-medium text-gray-800">
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
            <label className="grid gap-1.5 text-sm font-medium text-gray-800">
              {t("matters.drafts.typeLabel")}
              <select
                value={documentType}
                onChange={(event) =>
                  setDocumentType(event.target.value as VeraStudioDocumentType)
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
            <button
              type="submit"
              disabled={!draftTitle.trim() || busyAction !== null}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-gray-950 px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busyAction === "create" && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {t("matters.drafts.create")}
            </button>
            {createFailure && (
              <p role="alert" className="text-sm text-red-700 sm:col-span-3">
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
