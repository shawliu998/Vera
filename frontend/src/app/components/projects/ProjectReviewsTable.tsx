"use client";

// Direct adaptation of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/projects/ProjectReviewsTable.tsx
import { MoreHorizontal, Table2, Trash2 } from "lucide-react";
import { useI18n } from "@/app/i18n";
import type { VeraTabularReview } from "@/app/lib/veraTabularApi";
import {
  TABLE_CHECKBOX_CLASS,
  TABLE_STICKY_CELL_BG,
  SkeletonDot,
  SkeletonLine,
  TableBody,
  TableCell,
  TableEmptyState,
  TableHeaderCell,
  TableHeaderRow,
  TablePrimaryCell,
  TableRow,
  TableScrollArea,
  TableStickyCell,
} from "@/app/components/shared/TablePrimitive";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ProjectReviewsTable({
  reviews,
  selectedIds,
  loading = false,
  creating = false,
  canCreate = true,
  onSelectionChange,
  onCreate,
  onOpen,
  onDelete,
}: {
  reviews: VeraTabularReview[];
  selectedIds: string[];
  loading?: boolean;
  creating?: boolean;
  canCreate?: boolean;
  onSelectionChange: (ids: string[]) => void;
  onCreate: () => void;
  onOpen: (review: VeraTabularReview) => void;
  onDelete: (review: VeraTabularReview) => void;
}) {
  const { t, formatDate } = useI18n();
  const allSelected =
    reviews.length > 0 && reviews.every((review) => selectedIds.includes(review.id));
  const someSelected =
    !allSelected && reviews.some((review) => selectedIds.includes(review.id));

  return (
    <TableScrollArea>
      <TableHeaderRow className="pr-8 md:pr-8">
        <TableStickyCell header>
          {loading ? (
            <SkeletonDot />
          ) : (
            <input
              type="checkbox"
              checked={allSelected}
              ref={(element) => {
                if (element) element.indeterminate = someSelected;
              }}
              onChange={() =>
                onSelectionChange(allSelected ? [] : reviews.map((review) => review.id))
              }
              className={TABLE_CHECKBOX_CLASS}
            />
          )}
          <span>{t("common.fields.name")}</span>
        </TableStickyCell>
        <TableHeaderCell className="ml-auto w-24">
          {t("tabular.list.columns")}
        </TableHeaderCell>
        <TableHeaderCell className="w-24">
          {t("tabular.list.documents")}
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
            <TableRow key={index} interactive={false} className="pr-8 md:pr-8">
              <TableStickyCell hover={false}>
                <div className="flex min-w-0 items-center gap-4">
                  <SkeletonDot />
                  <SkeletonLine className="h-3.5 w-44" />
                </div>
              </TableStickyCell>
              <TableCell className="ml-auto w-24"><SkeletonLine className="w-8" /></TableCell>
              <TableCell className="w-24"><SkeletonLine className="w-8" /></TableCell>
              <TableCell className="w-28"><SkeletonLine className="w-16" /></TableCell>
              <TableCell className="w-32"><SkeletonLine className="w-20" /></TableCell>
              <TableCell className="w-8" />
            </TableRow>
          ))}
        </TableBody>
      ) : reviews.length === 0 ? (
        <TableEmptyState>
          <Table2 className="mb-4 h-8 w-8 text-gray-300" />
          <p className="font-serif text-2xl font-medium text-gray-900">
            {t("tabular.empty.title")}
          </p>
          <p className="mt-1 max-w-xs text-xs text-gray-400">
            {t("tabular.empty.body")}
          </p>
          <button
            type="button"
            onClick={onCreate}
            disabled={creating || !canCreate}
            className="mt-4 inline-flex items-center gap-1 rounded-full bg-gray-900 px-3 py-1 text-xs font-medium text-white shadow-md hover:bg-gray-700 disabled:opacity-40"
          >
            + {t("tabular.create")}
          </button>
        </TableEmptyState>
      ) : (
        <TableBody>
          {reviews.map((review) => {
            const selected = selectedIds.includes(review.id);
            return (
              <TableRow
                key={review.id}
                onClick={() => onOpen(review)}
                className="pr-8 md:pr-8"
              >
                <TablePrimaryCell
                  bgClassName={selected ? "bg-gray-50" : TABLE_STICKY_CELL_BG}
                  selected={selected}
                  onSelectionChange={() =>
                    onSelectionChange(
                      selected
                        ? selectedIds.filter((id) => id !== review.id)
                        : [...selectedIds, review.id],
                    )
                  }
                  label={review.title}
                />
                <TableCell className="ml-auto w-24">
                  {review.columns_config.length}
                </TableCell>
                <TableCell className="w-24">{review.document_count}</TableCell>
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
                        onSelect={() => onDelete(review)}
                        className="cursor-pointer text-xs text-red-600 focus:bg-red-50 focus:text-red-700"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {t("common.actions.delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </TableRow>
            );
          })}
        </TableBody>
      )}
    </TableScrollArea>
  );
}
