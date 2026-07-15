"use client";

// Direct structural adaptation of Mike
// e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/tabular/TabularReviewView.tsx
import {
  Download,
  FilePlus2,
  Loader2,
  Pencil,
  Play,
  RefreshCw,
  Square,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmPopup } from "@/app/components/shared/ConfirmPopup";
import { HeaderActionsMenu } from "@/app/components/shared/HeaderActionsMenu";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { PageHeader } from "@/app/components/vera-shell/PageHeader";
import { useI18n } from "@/app/i18n";
import { listVeraProjects } from "@/app/lib/veraApi";
import {
  getVeraModelSettingsStatus,
  type VeraModelProfile,
} from "@/app/lib/veraModelSettingsApi";
import {
  cancelVeraTabularCell,
  clearVeraTabularCells,
  deleteVeraTabularReview,
  exportVeraTabularReview,
  getVeraTabularCapabilities,
  getVeraTabularReview,
  regenerateVeraTabularCell,
  streamVeraTabularGeneration,
  updateVeraTabularReview,
  type VeraTabularCell,
  type VeraTabularCellContent,
  type VeraTabularColumn,
  type VeraTabularReviewDetail,
} from "@/app/lib/veraTabularApi";
import type { VeraProjectWire } from "@/app/lib/veraWireTypes";
import { AddColumnModal } from "./AddColumnModal";
import { TabularDocumentsModal } from "./TabularDocumentsModal";
import { TabularReviewDetailsModal } from "./TabularReviewDetailsModal";
import { TRSidePanel } from "./TRSidePanel";
import { TRTable } from "./TRTable";

type LiveCellUpdate = {
  content: VeraTabularCellContent | null;
  status: "generating" | "done" | "error";
};

const TABULAR_MUTATION_CONCURRENCY = 4;

async function runBoundedMutations<T>(
  values: readonly T[],
  mutate: (value: T) => Promise<unknown>,
): Promise<void> {
  let nextIndex = 0;
  const failures: unknown[] = [];
  const workers = Array.from(
    {
      length: Math.min(TABULAR_MUTATION_CONCURRENCY, values.length),
    },
    async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) return;
        try {
          await mutate(values[index]!);
        } catch (reason) {
          failures.push(reason);
        }
      }
    },
  );
  await Promise.all(workers);
  if (failures.length > 0) throw failures[0];
}

function cellKey(documentId: string, columnIndex: number): string {
  return `${documentId}:${columnIndex}`;
}

function readyModel(profile: VeraModelProfile): boolean {
  return (
    profile.enabled &&
    profile.availability.selectable &&
    profile.connection_test.status === "passed"
  );
}

function fallbackExportName(title: string, format: "csv" | "xlsx"): string {
  const base = title
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f\\/]/g, "-")
    .trim()
    .slice(0, 180);
  return `${base || "vera-tabular-review"}.${format}`;
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  queueMicrotask(() => URL.revokeObjectURL(url));
}

export function TabularReviewView({
  reviewId,
  projectId,
}: {
  reviewId: string;
  projectId?: string;
}) {
  const router = useRouter();
  const { t, errorMessage } = useI18n();
  const [detail, setDetail] = useState<VeraTabularReviewDetail | null>(null);
  const [projects, setProjects] = useState<VeraProjectWire[]>([]);
  const [models, setModels] = useState<VeraModelProfile[]>([]);
  const [generationAvailable, setGenerationAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [liveUpdates, setLiveUpdates] = useState<Record<string, LiveCellUpdate>>({});
  const [columnModalOpen, setColumnModalOpen] = useState(false);
  const [editingColumn, setEditingColumn] = useState<VeraTabularColumn>();
  const [documentsModalOpen, setDocumentsModalOpen] = useState(false);
  const [detailsModalOpen, setDetailsModalOpen] = useState(false);
  const [expandedCellId, setExpandedCellId] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [clearConfirmDocumentIds, setClearConfirmDocumentIds] = useState<
    string[] | null
  >(null);
  const generationController = useRef<AbortController | null>(null);
  const mutationLock = useRef(false);

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const loaded = await getVeraTabularReview(reviewId, signal);
      if (projectId && loaded.review.project_id !== projectId) {
        throw new Error(t("tabular.errors.projectScope"));
      }
      if (!signal?.aborted) setDetail(loaded);
      return loaded;
    },
    [projectId, reviewId, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setLoading(true);
        setError(null);
      }
    });
    Promise.all([
      reload(controller.signal),
      getVeraTabularCapabilities(controller.signal),
      listVeraProjects(controller.signal),
      getVeraModelSettingsStatus({ signal: controller.signal }),
    ])
      .then(([, capabilities, loadedProjects, settings]) => {
        if (controller.signal.aborted) return;
        setGenerationAvailable(capabilities.generation);
        setProjects(loadedProjects);
        setModels(settings.models.filter(readyModel));
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason as Error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      generationController.current?.abort();
      generationController.current = null;
    };
  }, [errorMessage, reload]);

  const hasPersistedActiveCells = detail?.cells.some(
    (cell) => cell.status === "generating",
  ) ?? false;
  const shouldPoll =
    detail?.review.status === "running" || hasPersistedActiveCells;

  useEffect(() => {
    if (!shouldPoll || generationController.current) return;
    const controller = new AbortController();
    let requestActive = false;
    const interval = window.setInterval(() => {
      if (requestActive || controller.signal.aborted) return;
      requestActive = true;
      reload(controller.signal)
        .then(() => setError(null))
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setError(errorMessage(reason as Error));
        })
        .finally(() => {
          requestActive = false;
        });
    }, 1_500);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [errorMessage, reload, shouldPoll]);

  const runMutation = async (
    key: string,
    operation: () => Promise<void>,
    rethrow = false,
  ) => {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setBusyAction(key);
    setError(null);
    try {
      await operation();
    } catch (reason) {
      setError(errorMessage(reason as Error));
      if (rethrow) throw reason;
    } finally {
      mutationLock.current = false;
      setBusyAction(null);
    }
  };

  const displayCells = useMemo(
    () =>
      (detail?.cells ?? []).map((cell) => {
        const live = liveUpdates[cellKey(cell.document_id, cell.column_index)];
        if (!live) return cell;
        return { ...cell, status: live.status, content: live.content };
      }),
    [detail?.cells, liveUpdates],
  );
  const hasActiveCells = displayCells.some(
    (cell) => cell.status === "generating",
  );
  const filteredDocuments = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return detail?.documents ?? [];
    return (detail?.documents ?? []).filter((document) =>
      document.filename.toLocaleLowerCase().includes(query),
    );
  }, [detail?.documents, search]);
  const expandedCell = displayCells.find((cell) => cell.id === expandedCellId) ?? null;
  const expandedDocument = expandedCell
    ? detail?.documents.find((document) => document.id === expandedCell.document_id)
    : undefined;
  const expandedColumn = expandedCell
    ? detail?.review.columns_config.find(
        (column) => column.index === expandedCell.column_index,
      )
    : undefined;
  const project = projects.find(
    (candidate) => candidate.id === detail?.review.project_id,
  );
  const activeModel = models.find(
    (model) => model.id === detail?.review.model_profile_id,
  );
  const failedRetryable = detail?.cells.filter(
    (cell) => cell.status === "error" && cell.error?.retryable,
  ) ?? [];
  const nextColumnIndex =
    detail?.review.columns_config.reduce(
      (maximum, column) => Math.max(maximum, column.index),
      -1,
    ) ?? -1;
  const maximumColumnCount = Math.min(
    100,
    detail && detail.review.document_ids.length > 0
      ? Math.floor(10_000 / detail.review.document_ids.length)
      : 100,
  );
  const canAddColumn =
    (detail?.review.columns_config.length ?? 0) < maximumColumnCount;

  const saveMatrix = async (
    columns: VeraTabularColumn[],
    documentIds = detail?.review.document_ids ?? [],
  ) => {
    if (!detail) return;
    const normalizedColumns = [...columns]
      .sort((left, right) => left.index - right.index)
      .map((column, index) => ({ ...column, index }));
    await updateVeraTabularReview(reviewId, {
      columns_config: normalizedColumns,
      document_ids: documentIds,
    });
    await reload();
    setLiveUpdates({});
  };

  const generate = async () => {
    if (
      !detail ||
      generationController.current ||
      !generationAvailable ||
      !activeModel ||
      ["archived", "cancelled"].includes(detail.review.status) ||
      detail.review.columns_config.length === 0 ||
      detail.review.document_ids.length === 0
    ) {
      return;
    }
    const controller = new AbortController();
    generationController.current = controller;
    setBusyAction("generate");
    setError(null);
    setLiveUpdates({});
    try {
      for await (const update of streamVeraTabularGeneration(
        reviewId,
        controller.signal,
      )) {
        setLiveUpdates((current) => ({
          ...current,
          [cellKey(update.document_id, update.column_index)]: update,
        }));
      }
      await reload();
      setLiveUpdates({});
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(errorMessage(reason as Error));
      }
      try {
        await reload();
      } catch {
        // Preserve the generation error; the next durable poll can recover.
      }
    } finally {
      if (generationController.current === controller) {
        generationController.current = null;
      }
      setBusyAction(null);
    }
  };

  const cancelAll = () =>
    runMutation("cancel-all", async () => {
      const active = displayCells.filter((cell) => cell.status === "generating");
      await runBoundedMutations(active, (cell) =>
        cancelVeraTabularCell(reviewId, {
          cell_id: cell.id,
          reason: "Tabular review cancellation requested by the local user.",
        }),
      );
      generationController.current?.abort();
      generationController.current = null;
      setLiveUpdates({});
      await reload();
    });

  const retryCell = (cell: VeraTabularCell) =>
    runMutation(`retry-${cell.id}`, async () => {
      await regenerateVeraTabularCell(
        reviewId,
        cell.document_id,
        cell.column_index,
      );
      await reload();
      setLiveUpdates({});
    });

  const retryFailed = () =>
    runMutation("retry-failed", async () => {
      await runBoundedMutations(failedRetryable, (cell) =>
        regenerateVeraTabularCell(
          reviewId,
          cell.document_id,
          cell.column_index,
        ),
      );
      await reload();
    });

  const exportReview = (format: "csv" | "xlsx") =>
    runMutation(`export-${format}`, async () => {
      if (!detail) return;
      const download = await exportVeraTabularReview(reviewId, format);
      saveBlob(
        download.blob,
        download.filename ?? fallbackExportName(detail.review.title, format),
      );
    });

  if (!loading && !detail) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md text-center">
          <Table2 className="mx-auto h-8 w-8 text-gray-300" />
          <h1 className="mt-4 font-serif text-2xl text-gray-900">
            {t("tabular.errors.notFound")}
          </h1>
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
          <button
            type="button"
            onClick={() => router.back()}
            className="mt-4 text-xs font-medium text-gray-600 hover:text-gray-950"
          >
            {t("common.actions.back")}
          </button>
        </div>
      </div>
    );
  }

  const review = detail?.review;
  const running = busyAction === "generate" || shouldPoll;
  const matrixMutable =
    !running && review?.status !== "archived" && review?.status !== "cancelled";
  const reviewRunnable =
    review !== undefined &&
    review.status !== "archived" &&
    review.status !== "cancelled";

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        shrink
        loading={loading}
        breadcrumbs={[
          ...(projectId
            ? [
                {
                  label: t("projects.title"),
                  onClick: () => router.push("/projects"),
                },
                {
                  label: project?.name ?? t("projects.title"),
                  onClick: () =>
                    router.push(`/projects/${projectId}/tabular-reviews`),
                },
              ]
            : [
                {
                  label: t("tabular.title"),
                  onClick: () => router.push("/tabular-review"),
                },
              ]),
          loading
            ? { loading: true, skeletonClassName: "w-40" }
            : { label: review?.title ?? "" },
        ]}
        actionGroups={[
          [
            {
              type: "search",
              value: search,
              onChange: setSearch,
              placeholder: t("tabular.searchDocuments"),
            },
            {
              type: "custom",
              render: (
                <HeaderActionsMenu
                  title={t("tabular.actions")}
                  items={[
                    {
                      label: t("tabular.details.title"),
                      icon: Pencil,
                      onSelect: () => setDetailsModalOpen(true),
                      disabled: !review || running,
                    },
                    {
                      label: t("tabular.exportCsv"),
                      icon: Download,
                      onSelect: () => void exportReview("csv"),
                      disabled: !review || review.document_ids.length === 0,
                    },
                    {
                      label: t("tabular.exportXlsx"),
                      icon: Download,
                      onSelect: () => void exportReview("xlsx"),
                      disabled: !review || review.document_ids.length === 0,
                    },
                    {
                      label: t("tabular.deleteConfirm.action"),
                      icon: Trash2,
                      variant: "danger",
                      onSelect: () => {
                        setDeleteConfirmName("");
                        setDeleteConfirmOpen(true);
                      },
                      disabled: running,
                    },
                  ]}
                />
              ),
            },
          ],
          {
            actions: running
              ? [
                  {
                    onClick: () => void cancelAll(),
                    disabled: busyAction === "cancel-all" || !hasActiveCells,
                    icon:
                      busyAction === "cancel-all" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Square className="h-4 w-4" />
                      ),
                    label: <span className="hidden sm:inline">{t("tabular.stop")}</span>,
                  },
                ]
              : [
                  {
                    onClick: () => void generate(),
                    disabled:
                      !generationAvailable ||
                      !activeModel ||
                      !review ||
                      !reviewRunnable ||
                      review.document_ids.length === 0 ||
                      review.columns_config.length === 0,
                    icon: <Play className="h-4 w-4" />,
                    label: <span className="hidden sm:inline">{t("tabular.run")}</span>,
                    tooltip: !activeModel ? t("tabular.new.noReadyModel") : undefined,
                  },
                ],
          },
        ]}
      />

      {error && (
        <div role="alert" className="mx-4 mb-2 flex items-center justify-between gap-3 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 md:mx-10">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label={t("common.actions.close")}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <TableToolbar
        items={[]}
        active="table"
        onChange={() => undefined}
        actions={
          <div className="ml-auto flex min-w-0 items-center gap-3 md:gap-5">
            {review && (
              <span className="hidden rounded-full bg-gray-100 px-2 py-1 text-[10px] text-gray-600 sm:inline-flex">
                {t(`tabular.reviewStatus.${review.status}`)}
              </span>
            )}
            {failedRetryable.length > 0 && !running && (
              <button
                type="button"
                onClick={() => void retryFailed()}
                disabled={busyAction !== null}
                className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 hover:text-amber-900 disabled:opacity-40"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t("tabular.retryFailed", { count: failedRetryable.length })}
              </button>
            )}
            {selectedDocumentIds.length > 0 && matrixMutable && (
              <button
                type="button"
                onClick={() =>
                  setClearConfirmDocumentIds([...selectedDocumentIds])
                }
                disabled={busyAction !== null}
                className="text-xs font-medium text-red-600 hover:text-red-800 disabled:opacity-40"
              >
                {t("tabular.clearSelected", { count: selectedDocumentIds.length })}
              </button>
            )}
            <button
              type="button"
              onClick={() => setDocumentsModalOpen(true)}
              disabled={!matrixMutable || !review?.project_id}
              className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-950 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <FilePlus2 className="h-3.5 w-3.5" />
              {t("tabular.addDocuments")}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditingColumn(undefined);
                setColumnModalOpen(true);
              }}
              disabled={!matrixMutable || !canAddColumn}
              title={!canAddColumn ? t("tabular.documents.matrixLimit") : undefined}
              className="text-xs font-medium text-gray-600 hover:text-gray-950 disabled:cursor-not-allowed disabled:opacity-40"
            >
              + {t("tabular.addColumn")}
            </button>
          </div>
        }
      />

      <TRTable
        loading={loading}
        columns={review?.columns_config ?? []}
        documents={filteredDocuments}
        cells={displayCells}
        selectedDocumentIds={selectedDocumentIds}
        disabled={!matrixMutable || busyAction !== null}
        canAddColumn={canAddColumn}
        onSelectionChange={setSelectedDocumentIds}
        onOpenCell={(cell) => setExpandedCellId(cell.id)}
        onEditColumn={(column) => {
          setEditingColumn(column);
          setColumnModalOpen(true);
        }}
        onDeleteColumn={async (columnIndex) => {
          if (!detail) return;
          await runMutation(`delete-column-${columnIndex}`, async () => {
            await saveMatrix(
              detail.review.columns_config.filter(
                (column) => column.index !== columnIndex,
              ),
            );
          }, true);
        }}
        onAddColumn={() => {
          setEditingColumn(undefined);
          setColumnModalOpen(true);
        }}
        onAddDocuments={() => setDocumentsModalOpen(true)}
      />

      {expandedCell && expandedDocument && expandedColumn && (
        <TRSidePanel
          cell={expandedCell}
          document={expandedDocument}
          column={expandedColumn}
          columns={review?.columns_config ?? []}
          busy={busyAction !== null || review?.status === "archived"}
          onClose={() => setExpandedCellId(null)}
          onNavigate={(columnIndex) => {
            const next = displayCells.find(
              (cell) =>
                cell.document_id === expandedCell.document_id &&
                cell.column_index === columnIndex,
            );
            if (next) setExpandedCellId(next.id);
          }}
          onRegenerate={() => retryCell(expandedCell)}
          onCancel={() =>
            runMutation(`cancel-${expandedCell.id}`, async () => {
              await cancelVeraTabularCell(reviewId, {
                cell_id: expandedCell.id,
                reason: "Tabular cell cancellation requested by the local user.",
              });
              await reload();
              setLiveUpdates((current) => {
                const next = { ...current };
                delete next[
                  cellKey(expandedCell.document_id, expandedCell.column_index)
                ];
                return next;
              });
            })
          }
          onClearDocument={() =>
            setClearConfirmDocumentIds([expandedCell.document_id])
          }
        />
      )}

      <AddColumnModal
        open={columnModalOpen}
        nextIndex={nextColumnIndex + 1}
        maxColumns={
          editingColumn
            ? 1
            : maximumColumnCount - (review?.columns_config.length ?? 0)
        }
        editingColumn={editingColumn}
        busy={busyAction !== null}
        onClose={() => {
          setColumnModalOpen(false);
          setEditingColumn(undefined);
        }}
        onAdd={async (added) => {
          if (!detail) return;
          await runMutation(
            "add-columns",
            () => saveMatrix([...detail.review.columns_config, ...added]),
            true,
          );
        }}
        onSave={async (saved) => {
          if (!detail) return;
          await runMutation(
            `edit-column-${saved.index}`,
            () => saveMatrix(
              detail.review.columns_config.map((column) =>
                column.index === saved.index ? saved : column,
              ),
            ),
            true,
          );
        }}
        onDelete={async (columnIndex) => {
          if (!detail) return;
          await runMutation(
            `delete-column-${columnIndex}`,
            () => saveMatrix(
              detail.review.columns_config.filter(
                (column) => column.index !== columnIndex,
              ),
            ),
            true,
          );
        }}
      />

      {review?.project_id && (
        <TabularDocumentsModal
          open={documentsModalOpen}
          projectId={review.project_id}
          selectedIds={review.document_ids}
          columnCount={review.columns_config.length}
          busy={busyAction !== null}
          onClose={() => setDocumentsModalOpen(false)}
          onSave={async (documentIds) => {
            await runMutation(
              "save-documents",
              () => saveMatrix(review.columns_config, documentIds),
              true,
            );
          }}
        />
      )}

      <TabularReviewDetailsModal
        open={detailsModalOpen}
        review={review ?? null}
        projects={projects}
        models={models}
        busy={busyAction !== null}
        lockProject={(review?.document_ids.length ?? 0) > 0}
        onClose={() => setDetailsModalOpen(false)}
        onSave={async (input) => {
          await runMutation("save-details", async () => {
            if (!review) return;
            const projectChanged = input.project_id !== review.project_id;
            const updated = await updateVeraTabularReview(reviewId, {
              title: input.title,
              model_profile_id: input.model_profile_id,
              ...(projectChanged
                ? {
                    project_id: input.project_id,
                    document_ids: review.document_ids,
                    columns_config: review.columns_config,
                  }
                : {}),
            });
            if (projectId && updated.project_id !== projectId) {
              router.replace(
                `/projects/${updated.project_id}/tabular-reviews/${reviewId}`,
              );
            } else {
              await reload();
            }
          }, true);
        }}
      />

      <ConfirmPopup
        open={clearConfirmDocumentIds !== null}
        title={t("tabular.clearConfirm.title")}
        message={t("tabular.clearConfirm.body", {
          count: clearConfirmDocumentIds?.length ?? 0,
        })}
        confirmLabel={t("tabular.clearConfirm.action")}
        confirmStatus={busyAction === "clear-results" ? "loading" : "idle"}
        cancelLabel={t("common.actions.cancel")}
        cancelDisabled={busyAction === "clear-results"}
        onCancel={() => {
          if (busyAction !== "clear-results") setClearConfirmDocumentIds(null);
        }}
        onConfirm={() =>
          void runMutation("clear-results", async () => {
            if (!clearConfirmDocumentIds) return;
            const ids = [...clearConfirmDocumentIds];
            await clearVeraTabularCells(reviewId, ids);
            setSelectedDocumentIds((current) =>
              current.filter((id) => !ids.includes(id)),
            );
            if (
              expandedCell &&
              ids.includes(expandedCell.document_id)
            ) {
              setExpandedCellId(null);
            }
            setClearConfirmDocumentIds(null);
            await reload();
          })
        }
      />

      <ConfirmPopup
        open={deleteConfirmOpen}
        title={t("tabular.deleteConfirm.title")}
        message={
          <div className="space-y-3">
            <p>{t("tabular.deleteConfirm.body")}</p>
            {review && (
              <label className="block space-y-1.5">
                <span className="block text-[11px] text-gray-500">
                  {t("tabular.deleteConfirm.namePrompt", { name: review.title })}
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
        confirmStatus={busyAction === "delete" ? "loading" : "idle"}
        confirmDisabled={!review || deleteConfirmName !== review.title}
        cancelLabel={t("common.actions.cancel")}
        cancelDisabled={busyAction === "delete"}
        onCancel={() => {
          if (busyAction !== "delete") {
            setDeleteConfirmOpen(false);
            setDeleteConfirmName("");
          }
        }}
        onConfirm={() =>
          void runMutation("delete", async () => {
            await deleteVeraTabularReview(reviewId);
            router.replace(
              projectId
                ? `/projects/${projectId}/tabular-reviews`
                : "/tabular-review",
            );
          })
        }
      />
    </div>
  );
}
