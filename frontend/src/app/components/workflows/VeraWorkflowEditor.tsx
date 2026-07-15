"use client";

/**
 * Adapted from Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238
 * frontend/src/app/components/workflows/WorkflowDetailPage.tsx.
 *
 * Vera keeps Mike's configuration hierarchy while replacing cloud sharing
 * with the local durable Assistant workflow execution surface.
 */

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Check, EyeOff, Loader2, Plus, RefreshCw, Save, X } from "lucide-react";

import { ConfirmPopup } from "@/app/components/shared/ConfirmPopup";
import { PageHeader } from "@/app/components/vera-shell/PageHeader";
import { useI18n } from "@/app/i18n";
import { VeraApiError } from "@/app/lib/veraApi";
import {
  deleteVeraWorkflow,
  getVeraWorkflowDefinition,
  getVeraWorkflow,
  hideVeraWorkflow,
  updateVeraWorkflow,
  VERA_WORKFLOW_FORMATS,
  type VeraWorkflow,
  type VeraWorkflowColumn,
  type VeraWorkflowDefinition,
  type VeraWorkflowFormat,
} from "@/app/lib/veraWorkflowApi";

import { VeraWorkflowDefinitionEditor } from "./VeraWorkflowDefinitionEditor";
import { VeraWorkflowFormModal } from "./VeraWorkflowFormModal";
import { VeraWorkflowRunPanel } from "./VeraWorkflowRunPanel";

// Mike keeps TipTap out of the server bundle; Vera retains that boundary.
const VeraWorkflowPromptEditor = dynamic(
  () =>
    import("./VeraWorkflowPromptEditor").then((module) => ({
      default: module.VeraWorkflowPromptEditor,
    })),
  { ssr: false },
);

const FORMAT_MESSAGE_KEYS = {
  text: "workflows.formats.text",
  bulleted_list: "workflows.formats.bulletedList",
  number: "workflows.formats.number",
  currency: "workflows.formats.currency",
  yes_no: "workflows.formats.yesNo",
  date: "workflows.formats.date",
  tag: "workflows.formats.tag",
  percentage: "workflows.formats.percentage",
  monetary_amount: "workflows.formats.monetaryAmount",
} as const;

function normalizedColumns(
  columns: VeraWorkflowColumn[] | null,
): VeraWorkflowColumn[] {
  return (columns ?? [])
    .slice()
    .sort((left, right) => left.index - right.index)
    .map((column, index) => ({
      ...column,
      index,
      tags: column.tags ?? [],
    }));
}

export function VeraWorkflowEditor({
  workflowId,
  initialProjectId = null,
}: {
  workflowId: string;
  initialProjectId?: string | null;
}) {
  const router = useRouter();
  const { t, errorMessage } = useI18n();
  const [workflow, setWorkflow] = useState<VeraWorkflow | null>(null);
  const [definition, setDefinition] = useState<VeraWorkflowDefinition | null>(
    null,
  );
  const [definitionLoading, setDefinitionLoading] = useState(false);
  const [definitionLoadError, setDefinitionLoadError] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [skillMarkdown, setSkillMarkdown] = useState("");
  const [columns, setColumns] = useState<VeraWorkflowColumn[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [editDetails, setEditDetails] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [hiddenBusy, setHiddenBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setLoadError(null);
      setDefinition(null);
      setDefinitionLoadError(null);
      try {
        const loaded = await getVeraWorkflow(workflowId, controller.signal);
        if (controller.signal.aborted) return;
        setWorkflow(loaded);
        setSkillMarkdown(loaded.skill_md ?? "");
        setColumns(normalizedColumns(loaded.columns_config));
        if (loaded.metadata.type === "assistant" && !loaded.is_system) {
          setDefinitionLoading(true);
          try {
            const loadedDefinition = await getVeraWorkflowDefinition(
              loaded.id,
              controller.signal,
            );
            if (!controller.signal.aborted) setDefinition(loadedDefinition);
          } catch (error) {
            if (!controller.signal.aborted) {
              setDefinitionLoadError(
                error instanceof VeraApiError
                  ? errorMessage(error)
                  : t("workflows.errors.definitionLoad"),
              );
            }
          } finally {
            if (!controller.signal.aborted) setDefinitionLoading(false);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setLoadError(
            error instanceof VeraApiError
              ? errorMessage(error)
              : t("workflows.errors.load"),
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [errorMessage, t, workflowId]);

  async function reloadDefinition() {
    if (!workflow || workflow.metadata.type !== "assistant" || workflow.is_system) {
      return;
    }
    setDefinitionLoading(true);
    setDefinitionLoadError(null);
    try {
      setDefinition(await getVeraWorkflowDefinition(workflow.id));
    } catch (error) {
      setDefinitionLoadError(
        error instanceof VeraApiError
          ? errorMessage(error)
          : t("workflows.errors.definitionLoad"),
      );
    } finally {
      setDefinitionLoading(false);
    }
  }

  const editable = Boolean(
    workflow && !workflow.is_system && workflow.allow_edit && workflow.is_owner,
  );
  const metadata = useMemo(() => {
    if (!workflow) return [];
    return [
      [
        t("workflows.editor.type"),
        workflow.metadata.type === "assistant"
          ? t("workflows.editor.assistantType")
          : t("workflows.editor.tabularType"),
      ],
      [
        t("workflows.editor.source"),
        workflow.is_system
          ? t("workflows.editor.builtinSource")
          : t("workflows.editor.localSource"),
      ],
      [t("workflows.editor.language"), workflow.metadata.language],
      [t("workflows.editor.practice"), workflow.metadata.practice ?? "—"],
      [
        t("workflows.editor.jurisdiction"),
        workflow.metadata.jurisdictions?.join("、") || "—",
      ],
    ] as const;
  }, [t, workflow]);
  const configuredDefinitionModelId = useMemo(() => {
    const ids = new Set(
      (definition?.steps ?? []).flatMap((step) =>
        step.type === "prompt" && step.model_profile_id
          ? [step.model_profile_id]
          : [],
      ),
    );
    return ids.size === 1 ? ([...ids][0] ?? null) : null;
  }, [definition]);

  async function persist(
    input: Parameters<typeof updateVeraWorkflow>[1],
    successMessage: string,
  ) {
    if (!workflow || saving) return;
    setSaving(true);
    setSaved(false);
    setOperationError(null);
    try {
      const updated = await updateVeraWorkflow(workflow.id, input);
      setWorkflow(updated);
      setSkillMarkdown(updated.skill_md ?? "");
      setColumns(normalizedColumns(updated.columns_config));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2_000);
    } catch (error) {
      setOperationError(
        error instanceof VeraApiError ? errorMessage(error) : successMessage,
      );
    } finally {
      setSaving(false);
    }
  }

  async function saveColumns() {
    if (
      columns.some((column) => !column.name.trim() || !column.prompt.trim())
    ) {
      setOperationError(t("errors.validation"));
      return;
    }
    await persist(
      {
        columns_config: columns.map((column, index) => ({
          ...column,
          index,
          name: column.name.trim(),
          prompt: column.prompt.trim(),
          ...(column.format === "tag" && column.tags?.length
            ? { tags: column.tags }
            : { tags: [] }),
        })),
      },
      t("workflows.errors.save"),
    );
  }

  async function updateDetails(
    input: Parameters<typeof updateVeraWorkflow>[1],
  ) {
    if (!workflow) return;
    setSaving(true);
    setOperationError(null);
    try {
      const updated = await updateVeraWorkflow(workflow.id, input);
      setWorkflow(updated);
      setDefinition((current) =>
        current
          ? {
              ...current,
              name: updated.metadata.title,
              description: updated.metadata.description,
            }
          : current,
      );
      setEditDetails(false);
    } catch (error) {
      setOperationError(
        error instanceof VeraApiError
          ? errorMessage(error)
          : t("workflows.errors.save"),
      );
    } finally {
      setSaving(false);
    }
  }

  async function toggleHidden() {
    if (!workflow || !workflow.is_system || hiddenBusy) return;

    setHiddenBusy(true);
    setOperationError(null);
    try {
      await hideVeraWorkflow(workflow.id);
      router.push("/workflows");
    } catch (error) {
      setOperationError(
        error instanceof VeraApiError
          ? errorMessage(error)
          : t("workflows.errors.save"),
      );
    } finally {
      setHiddenBusy(false);
    }
  }

  async function deleteWorkflow() {
    if (!workflow || deleteBusy) return;
    setDeleteBusy(true);
    setOperationError(null);
    try {
      await deleteVeraWorkflow(workflow.id);
      router.replace("/workflows");
    } catch (error) {
      setOperationError(
        error instanceof VeraApiError
          ? errorMessage(error)
          : t("workflows.errors.save"),
      );
      setDeleteBusy(false);
    }
  }

  function updateColumn(index: number, patch: Partial<VeraWorkflowColumn>) {
    setColumns((current) =>
      current.map((column) =>
        column.index === index ? { ...column, ...patch } : column,
      ),
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-500">
        {t("workflows.editor.loading")}
      </div>
    );
  }
  if (!workflow) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-lg font-medium text-gray-900">
          {t("workflows.editor.notFound")}
        </p>
        <p role="alert" className="max-w-lg text-sm text-red-700">
          {loadError ?? t("errors.notFound")}
        </p>
        <button
          type="button"
          onClick={() => router.push("/workflows")}
          className="rounded-full bg-gray-900 px-4 py-2 text-sm text-white"
        >
          {t("workflows.editor.back")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        shrink
        breadcrumbs={[
          {
            label: t("workflows.title"),
            onClick: () => router.push("/workflows"),
            title: t("workflows.editor.back"),
          },
          { label: workflow.metadata.title },
        ]}
        actionGroups={[
          saved
            ? [
                {
                  type: "custom",
                  render: (
                    <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                      <Check className="h-3.5 w-3.5" />
                      {t("workflows.editor.saved")}
                    </span>
                  ),
                },
              ]
            : [],
          [
            ...(editable
              ? [
                  {
                    type: "button" as const,
                    label: t("workflows.editor.details"),
                    onClick: () => setEditDetails(true),
                  },
                ]
              : []),
            ...(workflow.is_system
              ? [
                  {
                    type: "button" as const,
                    icon: <EyeOff className="h-4 w-4" />,
                    label: hiddenBusy
                      ? t("workflows.editor.hidingBuiltin")
                      : t("workflows.editor.hideBuiltin"),
                    title: hiddenBusy
                      ? t("workflows.editor.hidingBuiltin")
                      : t("workflows.editor.hideBuiltin"),
                    disabled: hiddenBusy,
                    onClick: () => void toggleHidden(),
                  },
                ]
              : []),
            ...(editable
              ? [
                  {
                    type: "delete" as const,
                    title: t("workflows.editor.delete"),
                    onClick: () => setDeleteOpen(true),
                  },
                ]
              : []),
          ],
        ]}
      />
      {operationError && (
        <p
          role="alert"
          className="mx-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 md:mx-10"
        >
          {operationError}
        </p>
      )}
      <div className="shrink-0 border-b border-gray-100 px-4 pb-4 pt-1 md:px-10">
        <p className="text-xs text-gray-500">{t("workflows.subtitle")}</p>
        <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3 text-xs">
          {metadata.map(([label, value]) => (
            <div key={label}>
              <dt className="text-gray-400">{label}</dt>
              <dd className="mt-0.5 text-gray-700">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      {workflow.metadata.type === "assistant" ? (
        workflow.is_system ? (
          <section className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-4 py-4 md:px-10 xl:grid-cols-[minmax(24rem,1.12fr)_minmax(24rem,0.88fr)] xl:overflow-hidden">
            <div className="flex min-h-[32rem] min-w-0 flex-col xl:min-h-0">
              <div className="mb-2">
                <h2 className="text-sm font-medium text-gray-900">
                  {t("workflows.editor.instructions")}
                </h2>
                <p className="mt-1 text-xs text-gray-500">
                  {t("workflows.editor.instructionsHint")}
                </p>
              </div>
              <div className="min-h-0 flex-1">
                <VeraWorkflowPromptEditor
                  value={skillMarkdown}
                  onChange={setSkillMarkdown}
                  readOnly
                />
              </div>
            </div>
            <VeraWorkflowRunPanel
              workflow={workflow}
              initialProjectId={initialProjectId}
            />
          </section>
        ) : definitionLoading ? (
          <div className="flex min-h-72 flex-1 items-center justify-center text-sm text-gray-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("workflows.definition.loading")}
          </div>
        ) : !definition ? (
          <div className="flex min-h-72 flex-1 flex-col items-center justify-center px-6 text-center">
            <p role="alert" className="max-w-xl text-sm text-red-700">
              {definitionLoadError ?? t("workflows.errors.definitionLoad")}
            </p>
            <button
              type="button"
              onClick={() => void reloadDefinition()}
              className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-gray-950 px-4 py-2 text-xs font-medium text-white"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t("common.actions.retry")}
            </button>
          </div>
        ) : (
          <section className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-4 py-4 md:px-10 xl:grid-cols-[minmax(25rem,1.12fr)_minmax(24rem,0.88fr)] xl:overflow-hidden">
            <div className="min-h-[32rem] min-w-0 xl:min-h-0 xl:overflow-y-auto">
              <VeraWorkflowDefinitionEditor
                definition={definition}
                editable={editable}
                onSaved={(updated) => {
                  setDefinition(updated);
                  setWorkflow((current) =>
                    current
                      ? {
                          ...current,
                          metadata: {
                            ...current.metadata,
                            title: updated.name,
                            description: updated.description,
                          },
                        }
                      : current,
                  );
                }}
              />
            </div>
            <VeraWorkflowRunPanel
              workflow={workflow}
              initialProjectId={definition.project_id ?? initialProjectId}
              boundProjectId={definition.project_id}
              configuredModelProfileId={configuredDefinitionModelId}
            />
          </section>
        )
      ) : (
        <section className="min-h-0 flex-1 overflow-auto px-4 py-4 md:px-10">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-medium text-gray-900">
                {t("workflows.editor.columns")}
              </h2>
              <p className="mt-1 text-xs text-gray-500">
                {t("workflows.editor.columnsHint")}
              </p>
            </div>
            {editable && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setColumns((current) => [
                      ...current,
                      {
                        index: current.length,
                        name: "",
                        prompt: "",
                        format: "text",
                        tags: [],
                      },
                    ])
                  }
                  className="inline-flex items-center gap-1 rounded-full border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t("workflows.editor.addColumn")}
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void saveColumns()}
                  className="inline-flex items-center gap-1 rounded-full bg-gray-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                >
                  <Save className="h-3.5 w-3.5" />
                  {saving
                    ? t("common.status.saving")
                    : t("workflows.editor.saveColumns")}
                </button>
              </div>
            )}
          </div>
          {columns.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center text-sm text-gray-500">
              {t("workflows.empty.body")}
            </div>
          ) : (
            <div className="min-w-[720px] overflow-hidden rounded-xl border border-gray-200">
              <div className="grid grid-cols-[minmax(160px,1fr)_140px_minmax(260px,2fr)_36px] border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs font-medium text-gray-500">
                <span>{t("workflows.editor.columnName")}</span>
                <span>{t("workflows.editor.columnFormat")}</span>
                <span>{t("workflows.editor.columnPrompt")}</span>
                <span />
              </div>
              {columns.map((column) => {
                const ordinal = column.index + 1;
                const descriptor = column.name.trim()
                  ? t("workflows.editor.columnDescriptorNamed", {
                      ordinal,
                      name: column.name.trim(),
                    })
                  : t("workflows.editor.columnDescriptor", { ordinal });
                const fieldId = `vera-workflow-column-${column.index}`;
                return (
                  <div
                    key={column.index}
                    className="grid grid-cols-[minmax(160px,1fr)_140px_minmax(260px,2fr)_36px] gap-2 border-b border-gray-100 px-3 py-2 last:border-0"
                  >
                    <div>
                      <label className="sr-only" htmlFor={`${fieldId}-name`}>
                        {`${descriptor} ${t("workflows.editor.columnName")}`}
                      </label>
                      <input
                        id={`${fieldId}-name`}
                        readOnly={!editable}
                        value={column.name}
                        maxLength={160}
                        onChange={(event) =>
                          updateColumn(column.index, {
                            name: event.target.value,
                          })
                        }
                        className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm read-only:border-transparent read-only:bg-transparent"
                      />
                    </div>
                    <div>
                      <label className="sr-only" htmlFor={`${fieldId}-format`}>
                        {`${descriptor} ${t("workflows.editor.columnFormat")}`}
                      </label>
                      <select
                        id={`${fieldId}-format`}
                        disabled={!editable}
                        value={column.format ?? "text"}
                        onChange={(event) =>
                          updateColumn(column.index, {
                            format: event.target.value as VeraWorkflowFormat,
                            tags:
                              event.target.value === "tag"
                                ? (column.tags ?? [])
                                : [],
                          })
                        }
                        className="w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-xs disabled:border-transparent disabled:bg-transparent"
                      >
                        {VERA_WORKFLOW_FORMATS.map((format) => (
                          <option key={format} value={format}>
                            {t(FORMAT_MESSAGE_KEYS[format])}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="sr-only" htmlFor={`${fieldId}-prompt`}>
                        {`${descriptor} ${t("workflows.editor.columnPrompt")}`}
                      </label>
                      <textarea
                        id={`${fieldId}-prompt`}
                        readOnly={!editable}
                        value={column.prompt}
                        maxLength={20_000}
                        onChange={(event) =>
                          updateColumn(column.index, {
                            prompt: event.target.value,
                          })
                        }
                        className="min-h-16 w-full rounded border border-gray-200 px-2 py-1.5 text-sm read-only:border-transparent read-only:bg-transparent"
                      />
                      {column.format === "tag" && (
                        <>
                          <label
                            className="sr-only"
                            htmlFor={`${fieldId}-tags`}
                          >
                            {`${descriptor} ${t("workflows.editor.tags")}`}
                          </label>
                          <input
                            id={`${fieldId}-tags`}
                            readOnly={!editable}
                            value={(column.tags ?? []).join("，")}
                            onChange={(event) =>
                              updateColumn(column.index, {
                                tags: event.target.value
                                  .split(/[，,]/)
                                  .map((tag) => tag.trim())
                                  .filter(Boolean),
                              })
                            }
                            placeholder={t("workflows.editor.tags")}
                            className="mt-1.5 h-8 w-full rounded border border-gray-200 px-2 text-xs read-only:border-transparent read-only:bg-transparent"
                          />
                        </>
                      )}
                    </div>
                    {editable && (
                      <button
                        type="button"
                        onClick={() =>
                          setColumns((current) =>
                            current
                              .filter((item) => item.index !== column.index)
                              .map((item, index) => ({ ...item, index })),
                          )
                        }
                        className="self-start rounded p-1.5 text-red-500 hover:bg-red-50"
                        aria-label={t("workflows.editor.removeColumn", {
                          name: descriptor,
                        })}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-4 max-w-2xl">
            <VeraWorkflowRunPanel
              workflow={workflow}
              initialProjectId={initialProjectId}
            />
          </div>
        </section>
      )}
      <VeraWorkflowFormModal
        key={editDetails ? `edit-${workflow.id}` : "edit-closed"}
        open={editDetails}
        mode="edit"
        workflow={workflow}
        busy={saving}
        error={operationError}
        onClose={() => !saving && setEditDetails(false)}
        onUpdate={updateDetails}
      />
      <ConfirmPopup
        open={deleteOpen}
        title={t("workflows.deleteConfirm.title")}
        message={t("workflows.deleteConfirm.body")}
        confirmLabel={t("common.actions.delete")}
        confirmStatus={deleteBusy ? "loading" : "idle"}
        onConfirm={() => void deleteWorkflow()}
        onCancel={() => !deleteBusy && setDeleteOpen(false)}
      />
    </div>
  );
}
