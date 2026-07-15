"use client";

// Adapted from Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/(pages)/projects/[id]/tabular-reviews/page.tsx
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmPopup } from "@/app/components/shared/ConfirmPopup";
import { ProjectReviewsTable } from "@/app/components/projects/ProjectReviewsTable";
import {
  ProjectSectionToolbar,
  useProjectWorkspace,
} from "@/app/components/projects/ProjectWorkspace";
import { NewTRModal } from "@/app/components/tabular/NewTRModal";
import { useI18n } from "@/app/i18n";
import {
  createVeraTabularReview,
  deleteVeraTabularReview,
  listVeraTabularReviews,
  type VeraTabularReview,
  type VeraTabularReviewCreateInput,
} from "@/app/lib/veraTabularApi";

const PAGE_SIZE = 50;

export default function ProjectTabularReviewsPage() {
  const router = useRouter();
  const { t, errorMessage } = useI18n();
  const { projectId, project, documents, search } = useProjectWorkspace();
  const [reviews, setReviews] = useState<VeraTabularReview[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newModalOpen, setNewModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [deleteReview, setDeleteReview] = useState<VeraTabularReview | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    listVeraTabularReviews(projectId, controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setReviews(loaded);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason as Error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [errorMessage, projectId]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return query
      ? reviews.filter((review) =>
          review.title.toLocaleLowerCase().includes(query),
        )
      : reviews;
  }, [reviews, search]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  useEffect(() => {
    if (page !== safePage) queueMicrotask(() => setPage(safePage));
  }, [page, safePage]);

  const create = async (input: VeraTabularReviewCreateInput) => {
    setCreating(true);
    setError(null);
    try {
      const created = await createVeraTabularReview(input);
      setNewModalOpen(false);
      router.push(`/projects/${projectId}/tabular-reviews/${created.id}`);
    } catch (reason) {
      setError(errorMessage(reason as Error));
      throw reason;
    } finally {
      setCreating(false);
    }
  };

  const confirmDelete = async () => {
    if (
      !deleteReview ||
      deleteConfirmName !== deleteReview.title ||
      deleting
    ) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await deleteVeraTabularReview(deleteReview.id);
      setReviews((current) =>
        current.filter((review) => review.id !== deleteReview.id),
      );
      setSelectedIds((current) =>
        current.filter((id) => id !== deleteReview.id),
      );
      setDeleteReview(null);
      setDeleteConfirmName("");
    } catch (reason) {
      setError(errorMessage(reason as Error));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <ProjectSectionToolbar
        actions={
          <div className="flex items-center gap-3">
            {selectedIds.length > 0 && (
              <button
                type="button"
                onClick={() => setSelectedIds([])}
                className="text-xs text-gray-500 hover:text-gray-900"
              >
                {t("tabular.list.clearSelection", { count: selectedIds.length })}
              </button>
            )}
            <button
              type="button"
              onClick={() => setNewModalOpen(true)}
              disabled={creating || documents.every((document) => document.status !== "ready")}
              className="rounded-full bg-gray-950 px-3 py-1 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-40"
            >
              + {t("tabular.create")}
            </button>
          </div>
        }
      />

      {error && (
        <div role="alert" className="mx-4 mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 md:mx-10">
          {error}
        </div>
      )}

      <ProjectReviewsTable
        reviews={pageItems}
        selectedIds={selectedIds}
        loading={loading}
        creating={creating}
        canCreate={documents.some((document) => document.status === "ready")}
        onSelectionChange={setSelectedIds}
        onCreate={() => setNewModalOpen(true)}
        onOpen={(review) =>
          router.push(`/projects/${projectId}/tabular-reviews/${review.id}`)
        }
        onDelete={(review) => {
          setDeleteReview(review);
          setDeleteConfirmName("");
        }}
      />

      {filtered.length > PAGE_SIZE && (
        <div className="flex h-10 shrink-0 items-center justify-between border-t border-gray-200 px-4 text-xs text-gray-500 md:px-10">
          <span>
            {t("tabular.table.pageRange", {
              start: safePage * PAGE_SIZE + 1,
              end: Math.min((safePage + 1) * PAGE_SIZE, filtered.length),
              total: filtered.length,
            })}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={safePage === 0}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              className="hover:text-gray-950 disabled:opacity-30"
            >
              {t("tabular.table.previousPage")}
            </button>
            <span>{safePage + 1} / {pageCount}</span>
            <button
              type="button"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
              className="hover:text-gray-950 disabled:opacity-30"
            >
              {t("tabular.table.nextPage")}
            </button>
          </div>
        </div>
      )}

      {project && (
        <NewTRModal
          open={newModalOpen}
          fixedProject={project}
          creating={creating}
          onClose={() => setNewModalOpen(false)}
          onCreate={create}
        />
      )}

      <ConfirmPopup
        open={deleteReview !== null}
        title={t("tabular.deleteConfirm.title")}
        message={
          <div className="space-y-3">
            <p>{t("tabular.deleteConfirm.body")}</p>
            {deleteReview && (
              <label className="block space-y-1.5">
                <span className="block text-[11px] text-gray-500">
                  {t("tabular.deleteConfirm.namePrompt", {
                    name: deleteReview.title,
                  })}
                </span>
                <input
                  autoFocus
                  value={deleteConfirmName}
                  onChange={(event) => setDeleteConfirmName(event.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-400"
                />
              </label>
            )}
          </div>
        }
        confirmLabel={t("common.actions.delete")}
        confirmStatus={deleting ? "loading" : "idle"}
        confirmDisabled={
          !deleteReview || deleteConfirmName !== deleteReview.title
        }
        cancelLabel={t("common.actions.cancel")}
        cancelDisabled={deleting}
        onCancel={() => {
          if (!deleting) {
            setDeleteReview(null);
            setDeleteConfirmName("");
          }
        }}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
