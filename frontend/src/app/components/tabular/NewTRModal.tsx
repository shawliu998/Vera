"use client";

// Adapted from Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/tabular/NewTRModal.tsx
import { useEffect, useMemo, useState } from "react";
import { FileText, Loader2, Plus } from "lucide-react";
import { Modal } from "@/app/components/shared/Modal";
import { useI18n } from "@/app/i18n";
import {
  listVeraProjectDocuments,
  listVeraProjects,
} from "@/app/lib/veraApi";
import {
  getVeraModelSettingsStatus,
  type VeraModelProfile,
} from "@/app/lib/veraModelSettingsApi";
import type {
  VeraDocumentWire,
  VeraProjectWire,
} from "@/app/lib/veraWireTypes";
import type {
  VeraTabularColumn,
  VeraTabularReviewCreateInput,
} from "@/app/lib/veraTabularApi";
import { AddColumnModal } from "./AddColumnModal";
import { formatOption } from "./columnFormat";

function readyModel(profile: VeraModelProfile): boolean {
  return (
    profile.enabled &&
    profile.availability.selectable &&
    profile.connection_test.status === "passed"
  );
}

export function NewTRModal({
  open,
  fixedProject,
  creating = false,
  onClose,
  onCreate,
}: {
  open: boolean;
  fixedProject?: Pick<VeraProjectWire, "id" | "name" | "default_model_profile_id">;
  creating?: boolean;
  onClose: () => void;
  onCreate: (input: VeraTabularReviewCreateInput) => Promise<void>;
}) {
  const { t, errorMessage } = useI18n();
  const [title, setTitle] = useState("");
  const [projects, setProjects] = useState<VeraProjectWire[]>([]);
  const [projectId, setProjectId] = useState<string>(fixedProject?.id ?? "");
  const [documents, setDocuments] = useState<VeraDocumentWire[]>([]);
  const [selectedDocuments, setSelectedDocuments] = useState<string[]>([]);
  const [models, setModels] = useState<VeraModelProfile[]>([]);
  const [modelProfileId, setModelProfileId] = useState("");
  const [columns, setColumns] = useState<VeraTabularColumn[]>([]);
  const [columnModalOpen, setColumnModalOpen] = useState(false);
  const [editingColumn, setEditingColumn] = useState<VeraTabularColumn>();
  const [loading, setLoading] = useState(false);
  const [loadingDocuments, setLoadingDocuments] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = "vera-new-tabular-review";
  const fixedProjectId = fixedProject?.id;
  const fixedDefaultModelProfileId = fixedProject?.default_model_profile_id;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setTitle("");
      setColumns([]);
      setSelectedDocuments([]);
      setEditingColumn(undefined);
      setColumnModalOpen(false);
      setError(null);
      setLoading(true);
      setProjectId(fixedProjectId ?? "");
    });
    Promise.all([
      fixedProjectId
        ? Promise.resolve([])
        : listVeraProjects(controller.signal),
      getVeraModelSettingsStatus({ signal: controller.signal }),
    ])
      .then(([loadedProjects, settings]) => {
        if (controller.signal.aborted) return;
        setProjects(loadedProjects);
        const selectable = settings.models.filter(readyModel);
        setModels(selectable);
        const projectDefault = fixedDefaultModelProfileId;
        const preferred =
          selectable.find((model) => model.id === projectDefault)?.id ??
          selectable.find(
            (model) => model.id === settings.settings.default_model_profile_id,
          )?.id ??
          selectable[0]?.id ??
          "";
        setModelProfileId(preferred);
        if (!fixedProjectId && settings.settings.default_project_id) {
          const defaultProject = loadedProjects.find(
            (project) => project.id === settings.settings.default_project_id,
          );
          if (defaultProject) setProjectId(defaultProject.id);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason as Error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    errorMessage,
    fixedDefaultModelProfileId,
    fixedProjectId,
    open,
  ]);

  useEffect(() => {
    if (!open || !projectId) {
      if (!projectId) {
        queueMicrotask(() => {
          setDocuments([]);
          setSelectedDocuments([]);
        });
      }
      return;
    }
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setLoadingDocuments(true);
        setSelectedDocuments([]);
      }
    });
    listVeraProjectDocuments(projectId, {}, controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setDocuments(loaded);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setDocuments([]);
          setError(errorMessage(reason as Error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingDocuments(false);
      });
    return () => controller.abort();
  }, [errorMessage, open, projectId]);

  const readyDocuments = useMemo(
    () => documents.filter((document) => document.status === "ready"),
    [documents],
  );
  const maximumDocumentCount =
    columns.length === 0 ? 1_000 : Math.floor(10_000 / columns.length);
  const maximumColumnCount = Math.min(
    100,
    selectedDocuments.length === 0
      ? 100
      : Math.floor(10_000 / selectedDocuments.length),
  );
  const selectableReadyDocuments = readyDocuments.slice(
    0,
    maximumDocumentCount,
  );
  const allSelectableDocumentsSelected =
    selectableReadyDocuments.length > 0 &&
    selectedDocuments.length === selectableReadyDocuments.length &&
    selectableReadyDocuments.every((document) =>
      selectedDocuments.includes(document.id),
    );
  const invalid =
    !title.trim() ||
    !projectId ||
    !modelProfileId ||
    selectedDocuments.length === 0 ||
    columns.length === 0 ||
    columns.length > 100 ||
    selectedDocuments.length * columns.length > 10_000;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (invalid || submitting || creating) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        title: title.trim(),
        project_id: projectId,
        model_profile_id: modelProfileId,
        document_ids: selectedDocuments,
        columns_config: columns,
      });
    } catch (reason) {
      setError(errorMessage(reason as Error));
    } finally {
      setSubmitting(false);
    }
  };

  const nextIndex =
    columns.reduce((maximum, column) => Math.max(maximum, column.index), -1) + 1;

  return (
    <>
      <Modal
        open={open}
        onClose={() => {
          if (!submitting && !creating) onClose();
        }}
        size="xl"
        breadcrumbs={[t("tabular.title"), t("tabular.new.title")]}
        primaryAction={{
          label:
            submitting || creating
              ? t("common.status.saving")
              : t("tabular.new.create"),
          type: "submit",
          form: formId,
          disabled: invalid || submitting || creating || loading,
          icon:
            submitting || creating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : undefined,
        }}
        cancelAction={{
          label: t("common.actions.cancel"),
          onClick: onClose,
          disabled: submitting || creating,
        }}
      >
        <form id={formId} onSubmit={(event) => void submit(event)} className="grid gap-5 pb-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="space-y-4">
            {error && (
              <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                {error}
              </p>
            )}
            <label className="block space-y-1.5 text-xs font-medium text-gray-700">
              <span>{t("tabular.new.name")}</span>
              <input
                autoFocus
                value={title}
                maxLength={240}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t("tabular.new.namePlaceholder")}
                className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-400"
              />
            </label>

            <label className="block space-y-1.5 text-xs font-medium text-gray-700">
              <span>{t("tabular.new.project")}</span>
              {fixedProject ? (
                <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-sm text-gray-700">
                  {fixedProject.name}
                </div>
              ) : (
                <select
                  value={projectId}
                  disabled={loading}
                  onChange={(event) => setProjectId(event.target.value)}
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-400"
                >
                  <option value="">{t("tabular.new.chooseProject")}</option>
                  {projects
                    .filter((project) => project.status === "active")
                    .map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                </select>
              )}
            </label>

            <label className="block space-y-1.5 text-xs font-medium text-gray-700">
              <span>{t("tabular.new.model")}</span>
              <select
                value={modelProfileId}
                disabled={loading || models.length === 0}
                onChange={(event) => setModelProfileId(event.target.value)}
                className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-400"
              >
                <option value="">{t("tabular.new.chooseModel")}</option>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} · {model.model}
                  </option>
                ))}
              </select>
              {models.length === 0 && !loading && (
                <span className="block text-xs font-normal text-amber-700">
                  {t("tabular.new.noReadyModel")}
                </span>
              )}
            </label>

            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-gray-700">
                  {t("tabular.columns.title")}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setEditingColumn(undefined);
                    setColumnModalOpen(true);
                  }}
                  disabled={columns.length >= maximumColumnCount}
                  title={
                    columns.length >= maximumColumnCount
                      ? t("tabular.documents.matrixLimit")
                      : undefined
                  }
                  className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-950 disabled:opacity-40"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t("tabular.columns.add")}
                </button>
              </div>
              {columns.length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-200 px-3 py-6 text-center text-xs text-gray-400">
                  {t("tabular.columns.empty")}
                </div>
              ) : (
                <div className="space-y-1">
                  {columns.map((column) => {
                    const option = formatOption(column.format);
                    const Icon = option.icon;
                    return (
                      <button
                        key={column.index}
                        type="button"
                        onClick={() => {
                          setEditingColumn(column);
                          setColumnModalOpen(true);
                        }}
                        className="flex w-full items-center gap-2 rounded-xl bg-gray-50 px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-100"
                      >
                        <Icon className={`h-3.5 w-3.5 ${option.iconClassName}`} />
                        <span className="min-w-0 flex-1 truncate">{column.name}</span>
                        <span className="text-gray-400">{t(option.labelKey)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          </div>

          <section className="flex min-h-[360px] flex-col rounded-2xl border border-gray-100 bg-gray-50/60 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <h3 className="text-xs font-medium text-gray-800">
                  {t("tabular.new.documents")}
                </h3>
                <p className="mt-0.5 text-[11px] text-gray-400">
                  {t("tabular.new.readyDocumentsOnly")}
                </p>
              </div>
              {selectableReadyDocuments.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setSelectedDocuments(
                      allSelectableDocumentsSelected
                        ? []
                        : selectableReadyDocuments.map(
                            (document) => document.id,
                          ),
                    )
                  }
                  className="text-xs text-gray-500 hover:text-gray-900"
                >
                  {allSelectableDocumentsSelected
                    ? t("tabular.new.clearSelection")
                    : t("tabular.new.selectAll")}
                </button>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-white bg-white/80">
              {loadingDocuments ? (
                <div className="flex h-full min-h-40 items-center justify-center text-gray-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : !projectId ? (
                <div className="flex h-full min-h-40 items-center justify-center px-6 text-center text-xs text-gray-400">
                  {t("tabular.new.chooseProjectFirst")}
                </div>
              ) : documents.length === 0 ? (
                <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-gray-400">
                  <FileText className="h-6 w-6 text-gray-300" />
                  {t("tabular.new.noDocuments")}
                </div>
              ) : (
                documents.map((document) => {
                  const selected = selectedDocuments.includes(document.id);
                  const ready = document.status === "ready";
                  const canSelect =
                    selected ||
                    (ready && selectedDocuments.length < maximumDocumentCount);
                  return (
                    <label
                      key={document.id}
                      className={`flex items-center gap-3 border-b border-gray-50 px-3 py-2.5 text-xs last:border-b-0 ${
                        canSelect
                          ? "cursor-pointer hover:bg-gray-50"
                          : "cursor-not-allowed opacity-50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={!canSelect}
                        onChange={() =>
                          setSelectedDocuments((current) =>
                            current.includes(document.id)
                              ? current.filter((id) => id !== document.id)
                              : [...current, document.id],
                          )
                        }
                        className="h-3 w-3 accent-black"
                      />
                      <FileText className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                      <span className="min-w-0 flex-1 truncate text-gray-700">
                        {document.filename}
                      </span>
                      {!ready && (
                        <span className="text-[10px] text-gray-400">
                          {t(`tabular.documentStatus.${document.status}`)}
                        </span>
                      )}
                    </label>
                  );
                })
              )}
            </div>
            <p className="mt-2 text-[11px] text-gray-400">
              {t("tabular.new.matrixSize", {
                documents: selectedDocuments.length,
                columns: columns.length,
                cells: selectedDocuments.length * columns.length,
              })}
              {` · ${t("tabular.documents.matrixLimit")}`}
            </p>
          </section>
        </form>
      </Modal>

      <AddColumnModal
        open={columnModalOpen}
        nextIndex={nextIndex}
        maxColumns={
          editingColumn ? 1 : maximumColumnCount - columns.length
        }
        editingColumn={editingColumn}
        onClose={() => {
          setColumnModalOpen(false);
          setEditingColumn(undefined);
        }}
        onAdd={(added) => setColumns((current) => [...current, ...added])}
        onSave={(saved) =>
          setColumns((current) =>
            current.map((column) =>
              column.index === saved.index ? saved : column,
            ),
          )
        }
        onDelete={(index) =>
          setColumns((current) =>
            current
              .filter((column) => column.index !== index)
              .map((column, position) => ({ ...column, index: position })),
          )
        }
      />
    </>
  );
}
