"use client";

/**
 * Workflow builder adapted to the compact configuration hierarchy in Mike
 * e32daad5a4c64a5561e04c53ee12411e3c5e7238
 * frontend/src/app/components/workflows/WorkflowDetailPage.tsx.
 *
 * Vera persists every field through its strict local definition API. The
 * reserved input mapping control is deliberately read-only until the runtime
 * has a real non-empty mapping contract.
 */

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Braces,
  FileSearch,
  Loader2,
  MessageSquareText,
  Plus,
  Save,
  Trash2,
} from "lucide-react";

import { useVeraSettings } from "@/app/contexts/VeraSettingsContext";
import { useI18n } from "@/app/i18n";
import { listVeraProjects, VeraApiError } from "@/app/lib/veraApi";
import type { VeraProjectWire } from "@/app/lib/veraWireTypes";
import {
  updateVeraWorkflowDefinition,
  type VeraWorkflowDefinition,
  type VeraWorkflowDefinitionStep,
  type VeraWorkflowDefinitionUpdate,
} from "@/app/lib/veraWorkflowApi";

type DefinitionEditorProps = {
  definition: VeraWorkflowDefinition;
  editable: boolean;
  onSaved: (definition: VeraWorkflowDefinition) => void;
};

type AddableStepType = VeraWorkflowDefinitionStep["type"];

function draftFrom(
  definition: VeraWorkflowDefinition,
): VeraWorkflowDefinitionUpdate {
  return {
    name: definition.name,
    description: definition.description,
    project_id: definition.project_id,
    steps: definition.steps.map((step) => ({ ...step })),
  };
}

function insertBeforeOutput(
  steps: VeraWorkflowDefinitionStep[],
  step: VeraWorkflowDefinitionStep,
) {
  const outputIndex = steps.findIndex((item) => item.type === "output");
  if (outputIndex === -1) return [...steps, step];
  return [
    ...steps.slice(0, outputIndex),
    step,
    ...steps.slice(outputIndex),
  ];
}

function stepIcon(type: AddableStepType) {
  if (type === "prompt") return MessageSquareText;
  if (type === "document_retrieval") return FileSearch;
  return Braces;
}

export function VeraWorkflowDefinitionEditor({
  definition,
  editable,
  onSaved,
}: DefinitionEditorProps) {
  const { t, errorMessage } = useI18n();
  const { models } = useVeraSettings();
  const [draft, setDraft] = useState(() => draftFrom(definition));
  const [projects, setProjects] = useState<VeraProjectWire[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(draftFrom(definition));
    setSaveError(null);
  }, [definition]);

  useEffect(() => {
    const controller = new AbortController();
    setProjectsLoading(true);
    setProjectsError(null);
    void listVeraProjects(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setProjects(items.filter((project) => project.status === "active"));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setProjects([]);
        setProjectsError(
          error instanceof VeraApiError
            ? errorMessage({ code: error.code, status: error.status })
            : t("workflows.definition.projectsLoadFailed"),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setProjectsLoading(false);
      });
    return () => controller.abort();
  }, [errorMessage, t]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(draftFrom(definition)),
    [definition, draft],
  );
  const configuredModelIds = useMemo(
    () =>
      new Set(
        draft.steps.flatMap((step) =>
          step.type === "prompt" && step.model_profile_id
            ? [step.model_profile_id]
            : [],
        ),
      ),
    [draft.steps],
  );
  const hasOutput = draft.steps.some((step) => step.type === "output");
  const boundProjectMissing = Boolean(
    draft.project_id &&
      !projectsLoading &&
      !projects.some((project) => project.id === draft.project_id),
  );

  function patchStep(
    id: string,
    update: (step: VeraWorkflowDefinitionStep) => VeraWorkflowDefinitionStep,
  ) {
    setSaved(false);
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step) =>
        step.id === id ? update(step) : step,
      ),
    }));
  }

  function addStep(type: AddableStepType) {
    if (!editable || draft.steps.length >= 100) return;
    const id = crypto.randomUUID();
    const step: VeraWorkflowDefinitionStep =
      type === "prompt"
        ? {
            id,
            type,
            name: t("workflows.definition.defaultPromptName"),
            prompt: "",
          }
        : type === "document_retrieval"
          ? {
              id,
              type,
              name: t("workflows.definition.defaultRetrievalName"),
              query_template: "",
              limit: 10,
            }
          : {
              id,
              type,
              name: t("workflows.definition.defaultOutputName"),
              format: "text",
            };
    setSaved(false);
    setDraft((current) => ({
      ...current,
      steps:
        type === "output"
          ? [...current.steps, step]
          : insertBeforeOutput(current.steps, step),
    }));
  }

  function removeStep(id: string) {
    if (!editable) return;
    setSaved(false);
    setDraft((current) => ({
      ...current,
      steps: current.steps.filter((step) => step.id !== id),
    }));
  }

  function moveStep(index: number, direction: -1 | 1) {
    if (!editable) return;
    const target = index + direction;
    if (
      target < 0 ||
      target >= draft.steps.length ||
      draft.steps[index]?.type === "output" ||
      draft.steps[target]?.type === "output"
    ) {
      return;
    }
    setSaved(false);
    setDraft((current) => {
      const steps = [...current.steps];
      [steps[index], steps[target]] = [steps[target]!, steps[index]!];
      return { ...current, steps };
    });
  }

  function validationMessage(): string | null {
    if (!draft.name.trim()) return t("workflows.definition.requiredFields");
    if (
      draft.steps.some((step) => {
        if (!step.name.trim()) return true;
        if (step.type === "prompt") return !step.prompt.trim();
        if (step.type === "document_retrieval") {
          return (
            !step.query_template.trim() ||
            !Number.isInteger(step.limit) ||
            step.limit < 1 ||
            step.limit > 100
          );
        }
        return false;
      })
    ) {
      return t("workflows.definition.requiredFields");
    }
    const outputIndex = draft.steps.findIndex((step) => step.type === "output");
    if (outputIndex !== -1 && outputIndex !== draft.steps.length - 1) {
      return t("workflows.definition.outputLast");
    }
    if (
      outputIndex !== -1 &&
      !draft.steps
        .slice(0, outputIndex)
        .some((step) => step.type === "prompt")
    ) {
      return t("workflows.definition.outputNeedsPrompt");
    }
    if (configuredModelIds.size > 1) {
      return t("workflows.definition.modelConflict");
    }
    return null;
  }

  async function save() {
    if (!editable || saving || !dirty) return;
    const validation = validationMessage();
    if (validation) {
      setSaveError(validation);
      return;
    }
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      const updated = await updateVeraWorkflowDefinition(definition.id, {
        name: draft.name.trim(),
        description: draft.description?.trim() || null,
        project_id: draft.project_id,
        steps: draft.steps.map((step) => {
          if (step.type === "prompt") {
            return {
              id: step.id,
              type: step.type,
              name: step.name.trim(),
              prompt: step.prompt.trim(),
              ...(step.model_profile_id
                ? { model_profile_id: step.model_profile_id }
                : {}),
            };
          }
          if (step.type === "document_retrieval") {
            return {
              ...step,
              name: step.name.trim(),
              query_template: step.query_template.trim(),
            };
          }
          return { ...step, name: step.name.trim() };
        }),
      });
      setDraft(draftFrom(updated));
      setSaved(true);
      onSaved(updated);
    } catch (error) {
      setSaveError(
        error instanceof VeraApiError
          ? errorMessage({ code: error.code, status: error.status })
          : t("workflows.errors.save"),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="min-w-0 rounded-2xl border border-gray-100 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 p-4">
        <div>
          <h2 className="text-sm font-medium text-gray-900">
            {t("workflows.definition.title")}
          </h2>
          <p className="mt-1 text-xs leading-5 text-gray-500">
            {t("workflows.definition.description")}
          </p>
        </div>
        {editable && (
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={() => void save()}
            className="inline-flex items-center gap-1.5 rounded-full bg-gray-950 px-3.5 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {saving
              ? t("common.status.saving")
              : t("workflows.definition.save")}
          </button>
        )}
      </div>

      <div className="space-y-4 p-4">
        {saved && (
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            {t("workflows.editor.saved")}
          </p>
        )}
        {saveError && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            {saveError}
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium text-gray-700">
            {t("workflows.definition.name")}
            <input
              value={draft.name}
              readOnly={!editable}
              maxLength={200}
              onChange={(event) => {
                setSaved(false);
                setDraft((current) => ({ ...current, name: event.target.value }));
              }}
              className="mt-1.5 h-9 w-full rounded-lg border border-gray-200 px-3 text-xs outline-none focus:border-gray-500 read-only:bg-gray-50"
            />
          </label>
          <label className="text-xs font-medium text-gray-700">
            {t("workflows.definition.project")}
            <select
              value={draft.project_id ?? ""}
              disabled={!editable || projectsLoading}
              onChange={(event) => {
                setSaved(false);
                setDraft((current) => ({
                  ...current,
                  project_id: event.target.value || null,
                }));
              }}
              className="mt-1.5 h-9 w-full rounded-lg border border-gray-200 bg-white px-2 text-xs outline-none focus:border-gray-500 disabled:bg-gray-50"
            >
              <option value="">{t("workflows.definition.noProject")}</option>
              {boundProjectMissing && draft.project_id && (
                <option value={draft.project_id}>
                  {t("workflows.definition.unavailableProject")}
                </option>
              )}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block text-xs font-medium text-gray-700">
          {t("workflows.definition.workflowDescription")}
          <textarea
            value={draft.description ?? ""}
            readOnly={!editable}
            maxLength={2_000}
            rows={2}
            onChange={(event) => {
              setSaved(false);
              setDraft((current) => ({
                ...current,
                description: event.target.value || null,
              }));
            }}
            placeholder={t("workflows.definition.descriptionPlaceholder")}
            className="mt-1.5 w-full resize-y rounded-lg border border-gray-200 px-3 py-2 text-xs leading-5 outline-none focus:border-gray-500 read-only:bg-gray-50"
          />
        </label>
        {projectsError && (
          <p role="alert" className="text-xs text-amber-700">
            {projectsError}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-4">
          <div>
            <h3 className="text-xs font-semibold text-gray-700">
              {t("workflows.definition.steps")}
            </h3>
            <p className="mt-1 text-[11px] text-gray-400">
              {t("workflows.definition.stepCount", { count: draft.steps.length })}
            </p>
          </div>
          {editable && (
            <div className="flex flex-wrap gap-1.5">
              {(["prompt", "document_retrieval", "output"] as const).map(
                (type) => {
                  const Icon = stepIcon(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      disabled={
                        draft.steps.length >= 100 ||
                        (type === "output" && hasOutput)
                      }
                      onClick={() => addStep(type)}
                      className="inline-flex items-center gap-1 rounded-full border border-gray-200 px-2.5 py-1.5 text-[11px] font-medium text-gray-600 hover:border-gray-400 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Plus className="h-3 w-3" />
                      <Icon className="h-3 w-3" />
                      {t(`workflows.definition.add.${type}`)}
                    </button>
                  );
                },
              )}
            </div>
          )}
        </div>

        {draft.steps.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-200 px-4 py-10 text-center text-xs text-gray-400">
            {t("workflows.definition.emptySteps")}
          </div>
        ) : (
          <ol className="space-y-3">
            {draft.steps.map((step, index) => {
              const Icon = stepIcon(step.type);
              const canMoveUp = index > 0 && step.type !== "output";
              const canMoveDown =
                step.type !== "output" &&
                index < draft.steps.length - 1 &&
                draft.steps[index + 1]?.type !== "output";
              const fieldPrefix = `vera-workflow-step-${step.id}`;
              return (
                <li
                  key={step.id}
                  className="rounded-xl border border-gray-200 bg-gray-50/50 p-3"
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white text-gray-600 shadow-sm">
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-[11px] font-semibold text-gray-500">
                          {t("workflows.definition.stepOrdinal", {
                            ordinal: index + 1,
                          })}
                        </span>
                        <span className="rounded bg-white px-1.5 py-0.5 text-[10px] text-gray-500">
                          {t(`workflows.definition.types.${step.type}`)}
                        </span>
                        <code
                          title={step.id}
                          className="min-w-0 truncate text-[9px] text-gray-400"
                        >
                          {step.id}
                        </code>
                      </div>
                    </div>
                    {editable && (
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          disabled={!canMoveUp}
                          onClick={() => moveStep(index, -1)}
                          title={t("workflows.definition.moveUp")}
                          aria-label={t("workflows.definition.moveUp")}
                          className="rounded p-1 text-gray-400 hover:bg-white hover:text-gray-700 disabled:opacity-25"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={!canMoveDown}
                          onClick={() => moveStep(index, 1)}
                          title={t("workflows.definition.moveDown")}
                          aria-label={t("workflows.definition.moveDown")}
                          className="rounded p-1 text-gray-400 hover:bg-white hover:text-gray-700 disabled:opacity-25"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeStep(step.id)}
                          title={t("workflows.definition.removeStep")}
                          aria-label={t("workflows.definition.removeStep")}
                          className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="mt-3 space-y-3">
                    <label
                      htmlFor={`${fieldPrefix}-name`}
                      className="block text-[11px] font-medium text-gray-600"
                    >
                      {t("workflows.definition.stepName")}
                      <input
                        id={`${fieldPrefix}-name`}
                        value={step.name}
                        readOnly={!editable}
                        maxLength={160}
                        onChange={(event) =>
                          patchStep(step.id, (current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                        className="mt-1 h-8 w-full rounded-lg border border-gray-200 bg-white px-2.5 text-xs outline-none focus:border-gray-500 read-only:bg-gray-50"
                      />
                    </label>

                    {step.type === "prompt" && (
                      <>
                        <label
                          htmlFor={`${fieldPrefix}-prompt`}
                          className="block text-[11px] font-medium text-gray-600"
                        >
                          {t("workflows.definition.prompt")}
                          <textarea
                            id={`${fieldPrefix}-prompt`}
                            value={step.prompt}
                            readOnly={!editable}
                            maxLength={20_000}
                            rows={5}
                            onChange={(event) =>
                              patchStep(step.id, (current) =>
                                current.type === "prompt"
                                  ? { ...current, prompt: event.target.value }
                                  : current,
                              )
                            }
                            placeholder={t("workflows.definition.promptPlaceholder")}
                            className="mt-1 w-full resize-y rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-xs leading-5 outline-none focus:border-gray-500 read-only:bg-gray-50"
                          />
                        </label>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label
                            htmlFor={`${fieldPrefix}-model`}
                            className="block text-[11px] font-medium text-gray-600"
                          >
                            {t("workflows.definition.stepModel")}
                            <select
                              id={`${fieldPrefix}-model`}
                              value={step.model_profile_id ?? ""}
                              disabled={!editable}
                              onChange={(event) =>
                                patchStep(step.id, (current) => {
                                  if (current.type !== "prompt") return current;
                                  const rest = { ...current };
                                  delete rest.model_profile_id;
                                  return event.target.value
                                    ? {
                                        ...rest,
                                        model_profile_id: event.target.value,
                                      }
                                    : rest;
                                })
                              }
                              className="mt-1 h-8 w-full rounded-lg border border-gray-200 bg-white px-2 text-xs outline-none focus:border-gray-500 disabled:bg-gray-50"
                            >
                              <option value="">
                                {t("workflows.definition.runModel")}
                              </option>
                              {models.map((model) => (
                                <option key={model.id} value={model.id}>
                                  {model.name} · {model.model}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label
                            htmlFor={`${fieldPrefix}-mapping`}
                            className="block text-[11px] font-medium text-gray-600"
                          >
                            {t("workflows.definition.inputMapping")}
                            <input
                              id={`${fieldPrefix}-mapping`}
                              value="{}"
                              readOnly
                              className="mt-1 h-8 w-full rounded-lg border border-gray-200 bg-gray-50 px-2 font-mono text-xs text-gray-500"
                            />
                            <span className="mt-1 block text-[10px] font-normal leading-4 text-gray-400">
                              {t("workflows.definition.inputMappingHint")}
                            </span>
                          </label>
                        </div>
                      </>
                    )}

                    {step.type === "document_retrieval" && (
                      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
                        <label
                          htmlFor={`${fieldPrefix}-query`}
                          className="block text-[11px] font-medium text-gray-600"
                        >
                          {t("workflows.definition.queryTemplate")}
                          <textarea
                            id={`${fieldPrefix}-query`}
                            value={step.query_template}
                            readOnly={!editable}
                            maxLength={2_000}
                            rows={3}
                            onChange={(event) =>
                              patchStep(step.id, (current) =>
                                current.type === "document_retrieval"
                                  ? {
                                      ...current,
                                      query_template: event.target.value,
                                    }
                                  : current,
                              )
                            }
                            placeholder={t("workflows.definition.queryPlaceholder")}
                            className="mt-1 w-full resize-y rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-xs leading-5 outline-none focus:border-gray-500 read-only:bg-gray-50"
                          />
                        </label>
                        <label
                          htmlFor={`${fieldPrefix}-limit`}
                          className="block text-[11px] font-medium text-gray-600"
                        >
                          {t("workflows.definition.limit")}
                          <input
                            id={`${fieldPrefix}-limit`}
                            type="number"
                            min={1}
                            max={100}
                            value={step.limit}
                            readOnly={!editable}
                            onChange={(event) =>
                              patchStep(step.id, (current) =>
                                current.type === "document_retrieval"
                                  ? {
                                      ...current,
                                      limit: Number(event.target.value),
                                    }
                                  : current,
                              )
                            }
                            className="mt-1 h-8 w-full rounded-lg border border-gray-200 bg-white px-2 text-xs outline-none focus:border-gray-500 read-only:bg-gray-50"
                          />
                        </label>
                      </div>
                    )}

                    {step.type === "output" && (
                      <label
                        htmlFor={`${fieldPrefix}-format`}
                        className="block text-[11px] font-medium text-gray-600"
                      >
                        {t("workflows.definition.outputFormat")}
                        <select
                          id={`${fieldPrefix}-format`}
                          value={step.format}
                          disabled={!editable}
                          onChange={(event) =>
                            patchStep(step.id, (current) =>
                              current.type === "output"
                                ? {
                                    ...current,
                                    format: event.target.value as "text" | "json",
                                  }
                                : current,
                            )
                          }
                          className="mt-1 h-8 w-full rounded-lg border border-gray-200 bg-white px-2 text-xs outline-none focus:border-gray-500 disabled:bg-gray-50 sm:w-48"
                        >
                          <option value="text">
                            {t("workflows.definition.outputText")}
                          </option>
                          <option value="json">
                            {t("workflows.definition.outputJson")}
                          </option>
                        </select>
                      </label>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
