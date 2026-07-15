"use client";

// Direct structural adaptation of Mike
// e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/(pages)/tabular-reviews/page.tsx
import { MoreHorizontal, Table2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmPopup } from "@/app/components/shared/ConfirmPopup";
import {
  SkeletonLine,
  TableBody,
  TableCell,
  TableEmptyState,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
  TableScrollArea,
  TableStickyCell,
} from "@/app/components/shared/TablePrimitive";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { PageHeader } from "@/app/components/vera-shell/PageHeader";
import { useI18n } from "@/app/i18n";
import { listVeraProjects } from "@/app/lib/veraApi";
import {
  createVeraTabularReview,
  deleteVeraTabularReview,
  listVeraTabularReviews,
  type VeraTabularReview,
  type VeraTabularReviewCreateInput,
} from "@/app/lib/veraTabularApi";
import type { VeraProjectWire } from "@/app/lib/veraWireTypes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NewTRModal } from "./NewTRModal";

const LIST_PAGE_SIZE = 50;

export function TabularReviewsList() {
  const router = useRouter();
  const { t, formatDate, errorMessage } = useI18n();
  const [reviews, setReviews] = useState<VeraTabularReview[]>([]);
  const [projects, setProjects] = useState<VeraProjectWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newModalOpen, setNewModalOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "finished">("all");
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [deleteReview, setDeleteReview] = useState<VeraTabularReview | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      listVeraTabularReviews(undefined, controller.signal),
      listVeraProjects(controller.signal),
    ])
      .then(([loadedReviews, loadedProjects]) => {
        if (controller.signal.aborted) return;
        setReviews(loadedReviews);
        setProjects(loadedProjects);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason as Error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [errorMessage]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return reviews.filter((review) => {
      if (projectFilter && review.project_id !== projectFilter) return false;
      if (
        statusFilter === "active" &&
        !["draft", "ready", "running"].includes(review.status)
      ) {
        return false;
      }
      if (
        statusFilter === "finished" &&
        !["complete", "failed", "cancelled"].includes(review.status)
      ) {
        return false;
      }
      return !query || review.title.toLocaleLowerCase().includes(query);
    });
  }, [projectFilter, reviews, search, statusFilter]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / LIST_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = filtered.slice(
    safePage * LIST_PAGE_SIZE,
    (safePage + 1) * LIST_PAGE_SIZE,
  );

  useEffect(() => {
    if (page !== safePage) queueMicrotask(() => setPage(safePage));
  }, [page, safePage]);

  const create = async (input: VeraTabularReviewCreateInput) => {
    setCreating(true);
    setError(null);
    try {
      const created = await createVeraTabularReview(input);
      setNewModalOpen(false);
      router.push(
        `/projects/${created.project_id}/tabular-reviews/${created.id}`,
      );
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
      setDeleteReview(null);
      setDeleteConfirmName("");
    } catch (reason) {
      setError(errorMessage(reason as Error));
    } finally {
      setDeleting(false);
    }
  };

  const projectName = (projectId: string | null) =>
    projects.find((project) => project.id === projectId)?.name ?? "—";

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        loading={loading}
        actions={[
          {
            type: "search",
            value: search,
            onChange: (value) => {
              setSearch(value);
              setPage(0);
            },
            placeholder: t("tabular.list.search"),
          },
          {
            type: "new",
            onClick: () => setNewModalOpen(true),
            loading: creating,
            title: t("tabular.create"),
          },
        ]}
      >
        <div>
          <h1 className="font-serif text-2xl font-medium text-gray-900">
            {t("tabular.title")}
          </h1>
          <p className="mt-1 text-xs text-gray-500">{t("tabular.subtitle")}</p>
        </div>
      </PageHeader>

      {error && (
        <div role="alert" className="mx-4 mb-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 md:mx-10">
          {error}
        </div>
      )}

      <TableToolbar
        items={[
          { id: "all", label: t("tabular.list.all") },
          { id: "active", label: t("tabular.list.active") },
          { id: "finished", label: t("tabular.list.finished") },
        ]}
        active={statusFilter}
        onChange={(value) => {
          setStatusFilter(value);
          setPage(0);
        }}
        actions={
          <label className="ml-auto flex items-center gap-2 text-xs text-gray-500">
            <span className="hidden sm:inline">{t("tabular.list.project")}</span>
            <select
              value={projectFilter}
              onChange={(event) => {
                setProjectFilter(event.target.value);
                setPage(0);
              }}
              className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 outline-none"
            >
              <option value="">{t("tabular.list.allProjects")}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        }
      />

      <TableScrollArea>
        <TableHeaderRow>
          <TableStickyCell header>{t("common.fields.name")}</TableStickyCell>
          <TableHeaderCell className="ml-auto w-24">
            {t("tabular.list.columns")}
          </TableHeaderCell>
          <TableHeaderCell className="w-24">
            {t("tabular.list.documents")}
          </TableHeaderCell>
          <TableHeaderCell className="w-36">
            {t("tabular.list.project")}
          </TableHeaderCell>
          <TableHeaderCell className="w-28">
            {t("tabular.list.status")}
          </TableHeaderCell>
          <TableHeaderCell className="w-32">
            {t("common.fields.updatedAt")}
          </TableHeaderCell>
          <TableHeaderCell className="w-8" />
        </TableHeaderRow>

        {loading ? (
          <TableBody>
            {Array.from({ length: 5 }, (_, index) => (
              <TableRow key={index} interactive={false}>
                <TableStickyCell hover={false}>
                  <SkeletonLine className="h-3.5 w-48" />
                </TableStickyCell>
                <TableCell className="ml-auto w-24"><SkeletonLine className="w-8" /></TableCell>
                <TableCell className="w-24"><SkeletonLine className="w-8" /></TableCell>
                <TableCell className="w-36"><SkeletonLine className="w-24" /></TableCell>
                <TableCell className="w-28"><SkeletonLine className="w-16" /></TableCell>
                <TableCell className="w-32"><SkeletonLine className="w-20" /></TableCell>
                <TableCell className="w-8" />
              </TableRow>
            ))}
          </TableBody>
        ) : pageItems.length === 0 ? (
          <TableEmptyState>
            <Table2 className="mb-4 h-8 w-8 text-gray-300" />
            <p className="font-serif text-2xl font-medium text-gray-900">
              {reviews.length === 0
                ? t("tabular.empty.title")
                : t("tabular.list.noMatches")}
            </p>
            <p className="mt-1 max-w-xs text-xs text-gray-400">
              {reviews.length === 0
                ? t("tabular.empty.body")
                : t("tabular.list.noMatchesBody")}
            </p>
            {reviews.length === 0 && (
              <button
                type="button"
                onClick={() => setNewModalOpen(true)}
                className="mt-4 rounded-full bg-gray-900 px-3 py-1.5 text-xs font-medium text-white"
              >
                + {t("tabular.create")}
              </button>
            )}
          </TableEmptyState>
        ) : (
          <TableBody>
            {pageItems.map((review) => (
              <TableRow
                key={review.id}
                onClick={() =>
                  router.push(
                    review.project_id
                      ? `/projects/${review.project_id}/tabular-reviews/${review.id}`
                      : `/tabular-review/${review.id}`,
                  )
                }
              >
                <TableStickyCell>
                  <span className="min-w-0 flex-1 truncate text-sm text-gray-800">
                    {review.title}
                  </span>
                </TableStickyCell>
                <TableCell className="ml-auto w-24">
                  {review.columns_config.length}
                </TableCell>
                <TableCell className="w-24">{review.document_count}</TableCell>
                <TableCell className="w-36">{projectName(review.project_id)}</TableCell>
                <TableCell className="w-28">
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-600">
                    {t(`tabular.reviewStatus.${review.status}`)}
                  </span>
                </TableCell>
                <TableCell className="w-32">{formatDate(review.updated_at)}</TableCell>
                <div
                  className="flex w-8 shrink-0 justify-end"
                  onClick={(event) => event.stopPropagation()}
                >
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={t("tabular.list.actions", { name: review.title })}
                        className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="z-[160] w-40 bg-white">
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => {
                          setDeleteReview(review);
                          setDeleteConfirmName("");
                        }}
                        className="cursor-pointer text-xs text-red-600 focus:bg-red-50 focus:text-red-700"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {t("common.actions.delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </TableRow>
            ))}
          </TableBody>
        )}
      </TableScrollArea>

      {filtered.length > LIST_PAGE_SIZE && (
        <div className="flex h-10 shrink-0 items-center justify-between border-t border-gray-200 px-4 text-xs text-gray-500 md:px-10">
          <span>
            {t("tabular.table.pageRange", {
              start: safePage * LIST_PAGE_SIZE + 1,
              end: Math.min((safePage + 1) * LIST_PAGE_SIZE, filtered.length),
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

      <NewTRModal
        open={newModalOpen}
        creating={creating}
        onClose={() => setNewModalOpen(false)}
        onCreate={create}
      />

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
