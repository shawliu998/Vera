"use client";

/**
 * Adapted from Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238
 * frontend/src/app/components/workflows/WorkflowDetailPage.tsx.
 *
 * Vera keeps configuration editing only. Workflow execution, sharing,
 * contribution, export, and cloud account controls are intentionally absent.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, EyeOff, Plus, Save, X } from "lucide-react";

import { ConfirmPopup } from "@/app/components/shared/ConfirmPopup";
import { PageHeader } from "@/app/components/vera-shell/PageHeader";
import {
  deleteVeraWorkflow,
  getVeraWorkflow,
  hideVeraWorkflow,
  updateVeraWorkflow,
  VERA_WORKFLOW_FORMATS,
  type VeraWorkflow,
  type VeraWorkflowColumn,
  type VeraWorkflowFormat,
} from "@/app/lib/veraWorkflowApi";

import { VeraWorkflowFormModal } from "./VeraWorkflowFormModal";

const FORMAT_LABELS: Record<VeraWorkflowFormat, string> = {
  text: "文本",
  bulleted_list: "项目列表",
  number: "数字",
  currency: "货币",
  yes_no: "是 / 否",
  date: "日期",
  tag: "标签",
  percentage: "百分比",
  monetary_amount: "金额",
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

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

export function VeraWorkflowEditor({ workflowId }: { workflowId: string }) {
  const router = useRouter();
  const [workflow, setWorkflow] = useState<VeraWorkflow | null>(null);
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
      try {
        const loaded = await getVeraWorkflow(workflowId, controller.signal);
        if (controller.signal.aborted) return;
        setWorkflow(loaded);
        setSkillMarkdown(loaded.skill_md ?? "");
        setColumns(normalizedColumns(loaded.columns_config));
      } catch (error) {
        if (!controller.signal.aborted)
          setLoadError(errorMessage(error, "无法加载工作流。"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [workflowId]);

  const editable = Boolean(
    workflow && !workflow.is_system && workflow.allow_edit && workflow.is_owner,
  );
  const metadata = useMemo(() => {
    if (!workflow) return [];
    return [
      ["类型", workflow.metadata.type === "assistant" ? "助手" : "表格审阅"],
      ["来源", workflow.is_system ? "Vera 内置模板" : "本地模板"],
      ["语言", workflow.metadata.language],
      ["业务领域", workflow.metadata.practice ?? "—"],
      ["司法辖区", workflow.metadata.jurisdictions?.join("、") || "—"],
    ] as const;
  }, [workflow]);

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
      setOperationError(errorMessage(error, successMessage));
    } finally {
      setSaving(false);
    }
  }

  async function saveAssistant() {
    await persist({ skill_md: skillMarkdown }, "无法保存工作流指令。");
  }

  async function saveColumns() {
    if (
      columns.some((column) => !column.name.trim() || !column.prompt.trim())
    ) {
      setOperationError("请填写每个表格列的名称和指令后再保存。");
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
      "无法保存表格列。",
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
      setEditDetails(false);
    } catch (error) {
      setOperationError(errorMessage(error, "无法保存工作流信息。"));
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
      setOperationError(errorMessage(error, "无法更新内置工作流显示状态。"));
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
      setOperationError(errorMessage(error, "无法删除工作流。"));
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
        正在加载工作流…
      </div>
    );
  }
  if (!workflow) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-lg font-medium text-gray-900">无法打开工作流</p>
        <p role="alert" className="max-w-lg text-sm text-red-700">
          {loadError ?? "工作流不存在。"}
        </p>
        <button
          type="button"
          onClick={() => router.push("/workflows")}
          className="rounded-full bg-gray-900 px-4 py-2 text-sm text-white"
        >
          返回工作流
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
            label: "工作流",
            onClick: () => router.push("/workflows"),
            title: "返回工作流",
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
                      已保存
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
                    label: "编辑信息",
                    onClick: () => setEditDetails(true),
                  },
                ]
              : []),
            ...(workflow.is_system
              ? [
                  {
                    type: "button" as const,
                    icon: <EyeOff className="h-4 w-4" />,
                    label: hiddenBusy ? "正在隐藏…" : "隐藏内置模板",
                    title: hiddenBusy ? "正在隐藏内置模板…" : "隐藏内置模板",
                    disabled: hiddenBusy,
                    onClick: () => void toggleHidden(),
                  },
                ]
              : []),
            ...(editable
              ? [
                  {
                    type: "delete" as const,
                    title: "删除工作流",
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
        <p className="text-xs text-gray-500">
          项目可选择性地使用此模板；当前配置页面不会启动或排队执行工作流。
        </p>
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
        <section className="flex min-h-0 flex-1 flex-col px-4 py-4 md:px-10">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-900">工作流指令</h2>
            {editable && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void saveAssistant()}
                className="inline-flex items-center gap-1 rounded-full bg-gray-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
              >
                <Save className="h-3.5 w-3.5" />
                {saving ? "正在保存…" : "保存"}
              </button>
            )}
          </div>
          <textarea
            aria-label="工作流指令"
            value={skillMarkdown}
            onChange={(event) => setSkillMarkdown(event.target.value)}
            readOnly={!editable}
            maxLength={100_000}
            placeholder="此工作流还没有指令。"
            className="min-h-72 flex-1 resize-none rounded-xl border border-gray-200 bg-white px-4 py-3 font-mono text-sm leading-6 text-gray-800 outline-none focus:border-gray-500 read-only:bg-gray-50 read-only:text-gray-600"
          />
        </section>
      ) : (
        <section className="min-h-0 flex-1 overflow-auto px-4 py-4 md:px-10">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-medium text-gray-900">提取列</h2>
              <p className="mt-1 text-xs text-gray-500">
                支持九种输出格式与标签语义。
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
                  添加列
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void saveColumns()}
                  className="inline-flex items-center gap-1 rounded-full bg-gray-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                >
                  <Save className="h-3.5 w-3.5" />
                  {saving ? "正在保存…" : "保存"}
                </button>
              </div>
            )}
          </div>
          {columns.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center text-sm text-gray-500">
              尚未配置提取列。
            </div>
          ) : (
            <div className="min-w-[720px] overflow-hidden rounded-xl border border-gray-200">
              <div className="grid grid-cols-[minmax(160px,1fr)_140px_minmax(260px,2fr)_36px] border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs font-medium text-gray-500">
                <span>列名称</span>
                <span>格式</span>
                <span>指令</span>
                <span />
              </div>
              {columns.map((column) => {
                const ordinal = column.index + 1;
                const descriptor = column.name.trim()
                  ? `第 ${ordinal} 列：${column.name.trim()}`
                  : `第 ${ordinal} 列`;
                const fieldId = `vera-workflow-column-${column.index}`;
                return (
                  <div
                    key={column.index}
                    className="grid grid-cols-[minmax(160px,1fr)_140px_minmax(260px,2fr)_36px] gap-2 border-b border-gray-100 px-3 py-2 last:border-0"
                  >
                    <div>
                      <label className="sr-only" htmlFor={`${fieldId}-name`}>
                        {descriptor}名称
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
                        {descriptor}格式
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
                            {FORMAT_LABELS[format]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="sr-only" htmlFor={`${fieldId}-prompt`}>
                        {descriptor}指令
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
                            {descriptor}标签，使用逗号分隔
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
                            placeholder="标签，逗号分隔"
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
                        aria-label={`删除${descriptor}`}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
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
        title="删除工作流？"
        message={`“${workflow.metadata.title}”将从本地工作区永久删除。`}
        confirmLabel="删除"
        confirmStatus={deleteBusy ? "loading" : "idle"}
        onConfirm={() => void deleteWorkflow()}
        onCancel={() => !deleteBusy && setDeleteOpen(false)}
      />
    </div>
  );
}
