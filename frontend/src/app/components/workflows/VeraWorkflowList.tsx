"use client";

/**
 * Adapted from Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238
 * frontend/src/app/components/workflows/WorkflowList.tsx.
 *
 * Vera preserves list/create/delete/hide semantics while intentionally
 * omitting shared-with-me, cloud contribution, and execution controls.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Eye,
  EyeOff,
  Library,
  MessageSquare,
  Plus,
  Table2,
  Trash2,
} from "lucide-react";

import { ConfirmPopup } from "@/app/components/shared/ConfirmPopup";
import { PageHeader } from "@/app/components/vera-shell/PageHeader";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
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
import {
  createVeraWorkflow,
  deleteVeraWorkflow,
  hideVeraWorkflow,
  listHiddenVeraWorkflows,
  listVeraWorkflows,
  unhideVeraWorkflow,
  type VeraWorkflow,
} from "@/app/lib/veraWorkflowApi";

import { VeraWorkflowFormModal } from "./VeraWorkflowFormModal";

type WorkflowScope = "all" | "custom" | "system";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function VeraWorkflowList() {
  const router = useRouter();
  const [workflows, setWorkflows] = useState<VeraWorkflow[]>([]);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [scope, setScope] = useState<WorkflowScope>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<VeraWorkflow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [hiddenPendingIds, setHiddenPendingIds] = useState<string[]>([]);
  const [deletePendingIds, setDeletePendingIds] = useState<string[]>([]);

  async function reload(signal?: AbortSignal) {
    setLoading(true);
    setLoadError(null);
    try {
      const [assistant, tabular, hidden] = await Promise.all([
        listVeraWorkflows("assistant", signal),
        listVeraWorkflows("tabular", signal),
        listHiddenVeraWorkflows(signal),
      ]);
      if (signal?.aborted) return;
      setWorkflows([...assistant, ...tabular]);
      setHiddenIds(hidden);
    } catch (error) {
      if (signal?.aborted) return;
      setWorkflows([]);
      setHiddenIds([]);
      setLoadError(errorMessage(error, "无法加载工作流。"));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, []);

  const scopedWorkflows = useMemo(() => {
    return workflows.filter((workflow) => {
      if (scope === "system") return workflow.is_system;
      if (scope === "custom") return !workflow.is_system;
      return true;
    });
  }, [scope, workflows]);

  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return scopedWorkflows
      .filter(
        (workflow) =>
          !normalizedQuery ||
          workflow.metadata.title
            .toLocaleLowerCase()
            .includes(normalizedQuery) ||
          (workflow.metadata.practice ?? "")
            .toLocaleLowerCase()
            .includes(normalizedQuery),
      )
      .sort((left, right) => {
        const leftHidden = hiddenIds.includes(left.id) ? 1 : 0;
        const rightHidden = hiddenIds.includes(right.id) ? 1 : 0;
        return (
          leftHidden - rightHidden ||
          left.metadata.title.localeCompare(right.metadata.title, "zh-CN")
        );
      });
  }, [hiddenIds, query, scopedWorkflows]);

  const hasActiveFilter = scope !== "all" || query.trim().length > 0;

  async function createWorkflow(
    input: Parameters<typeof createVeraWorkflow>[0],
  ) {
    setCreateBusy(true);
    setOperationError(null);
    try {
      const created = await createVeraWorkflow(input);
      setWorkflows((current) => [created, ...current]);
      setCreateOpen(false);
      router.push(`/workflows/${encodeURIComponent(created.id)}`);
    } catch (error) {
      setOperationError(errorMessage(error, "无法创建工作流。"));
    } finally {
      setCreateBusy(false);
    }
  }

  async function toggleHidden(workflow: VeraWorkflow) {
    if (hiddenPendingIds.includes(workflow.id)) return;
    const wasHidden = hiddenIds.includes(workflow.id);
    setHiddenPendingIds((current) => [...current, workflow.id]);
    setHiddenIds((current) =>
      wasHidden
        ? current.filter((id) => id !== workflow.id)
        : [...new Set([...current, workflow.id])],
    );
    setOperationError(null);
    try {
      if (wasHidden) {
        await unhideVeraWorkflow(workflow.id);
      } else {
        await hideVeraWorkflow(workflow.id);
      }
    } catch (error) {
      setHiddenIds((current) =>
        wasHidden
          ? [...new Set([...current, workflow.id])]
          : current.filter((id) => id !== workflow.id),
      );
      setOperationError(errorMessage(error, "无法更新内置工作流显示状态。"));
    } finally {
      setHiddenPendingIds((current) =>
        current.filter((id) => id !== workflow.id),
      );
    }
  }

  async function deleteWorkflow() {
    if (
      !deleteTarget ||
      deleteBusy ||
      deletePendingIds.includes(deleteTarget.id)
    ) {
      return;
    }
    const targetId = deleteTarget.id;
    setDeleteBusy(true);
    setDeletePendingIds((current) => [...current, targetId]);
    setOperationError(null);
    try {
      await deleteVeraWorkflow(targetId);
      setWorkflows((current) =>
        current.filter((workflow) => workflow.id !== targetId),
      );
      setDeleteTarget(null);
    } catch (error) {
      setOperationError(errorMessage(error, "无法删除工作流。"));
    } finally {
      setDeleteBusy(false);
      setDeletePendingIds((current) => current.filter((id) => id !== targetId));
    }
  }

  function clearFilters() {
    setScope("all");
    setQuery("");
  }

  function openWorkflow(workflowId: string) {
    router.push(`/workflows/${encodeURIComponent(workflowId)}`);
  }

  const deleteControlsLocked =
    deleteTarget !== null || deleteBusy || deletePendingIds.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        shrink
        breadcrumbs={[{ label: "工作流" }]}
        actionGroups={[
          [
            {
              type: "search",
              value: query,
              onChange: setQuery,
              placeholder: "搜索工作流",
            },
          ],
          [
            {
              type: "new",
              onClick: () => {
                setOperationError(null);
                setCreateOpen(true);
              },
              title: "新建工作流",
            },
          ],
        ]}
      />
      <TableToolbar
        items={[
          { id: "all", label: "全部" },
          { id: "custom", label: "我的模板" },
          { id: "system", label: "内置模板" },
        ]}
        active={scope}
        onChange={setScope}
        actions={
          <p className="text-xs text-gray-500">
            项目可选择性地使用这些模板；此处不启动执行。
          </p>
        }
      />
      {operationError && (
        <p
          role="alert"
          className="mx-4 mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 md:mx-10"
        >
          {operationError}
        </p>
      )}
      <TableScrollArea>
        <TableHeaderRow>
          <TableStickyCell header>
            <span>名称</span>
          </TableStickyCell>
          <TableHeaderCell className="w-28">类型</TableHeaderCell>
          <TableHeaderCell className="w-36">业务领域</TableHeaderCell>
          <TableHeaderCell className="w-44">司法辖区</TableHeaderCell>
          <TableHeaderCell className="w-28">来源</TableHeaderCell>
          <TableHeaderCell className="w-28" />
        </TableHeaderRow>
        {loading ? (
          <TableBody>
            {[1, 2, 3].map((index) => (
              <TableRow key={index} interactive={false}>
                <TableStickyCell>
                  <SkeletonLine className="w-52" />
                </TableStickyCell>
                <TableCell className="w-28">
                  <SkeletonLine className="w-16" />
                </TableCell>
                <TableCell className="w-36">
                  <SkeletonLine className="w-20" />
                </TableCell>
                <TableCell className="w-44">
                  <SkeletonLine className="w-28" />
                </TableCell>
                <TableCell className="w-28">
                  <SkeletonLine className="w-16" />
                </TableCell>
                <TableCell className="w-28" />
              </TableRow>
            ))}
          </TableBody>
        ) : loadError ? (
          <TableEmptyState>
            <Library className="mb-4 h-8 w-8 text-red-300" />
            <p className="text-xl font-medium text-gray-900">无法加载工作流</p>
            <p
              role="alert"
              className="mt-2 max-w-md text-center text-sm text-red-700"
            >
              {loadError}
            </p>
            <button
              type="button"
              onClick={() => void reload()}
              className="mt-4 rounded-full bg-gray-900 px-4 py-2 text-sm font-medium text-white"
            >
              重试
            </button>
          </TableEmptyState>
        ) : visible.length === 0 && workflows.length > 0 && hasActiveFilter ? (
          <TableEmptyState>
            <Library className="mb-4 h-8 w-8 text-gray-300" />
            <p className="text-xl font-medium text-gray-900">
              没有匹配的工作流
            </p>
            <p className="mt-2 max-w-md text-center text-sm text-gray-500">
              当前搜索或筛选条件没有匹配项；本地数据未被更改。
            </p>
            <button
              type="button"
              onClick={clearFilters}
              className="mt-4 rounded-full border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:border-gray-400"
            >
              清除筛选
            </button>
          </TableEmptyState>
        ) : visible.length === 0 ? (
          <TableEmptyState>
            <Library className="mb-4 h-8 w-8 text-gray-300" />
            <p className="text-xl font-medium text-gray-900">还没有工作流</p>
            <p className="mt-2 max-w-md text-center text-sm text-gray-500">
              创建助手或表格审阅模板。Vera 会显示真实本地服务结果。
            </p>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="mt-4 inline-flex items-center gap-1 rounded-full bg-gray-900 px-4 py-2 text-sm font-medium text-white"
            >
              <Plus className="h-4 w-4" />
              新建工作流
            </button>
          </TableEmptyState>
        ) : (
          <TableBody>
            {visible.map((workflow) => {
              const hidden = hiddenIds.includes(workflow.id);
              const hiddenPending = hiddenPendingIds.includes(workflow.id);
              const deletePending = deletePendingIds.includes(workflow.id);
              const editable =
                !workflow.is_system && workflow.allow_edit && workflow.is_owner;
              return (
                <TableRow
                  key={workflow.id}
                  className={hidden ? "opacity-50" : undefined}
                  role="link"
                  tabIndex={0}
                  aria-label={`打开工作流：${workflow.metadata.title}`}
                  onClick={() => openWorkflow(workflow.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openWorkflow(workflow.id);
                    }
                  }}
                >
                  <TableStickyCell>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-gray-900">
                        {workflow.metadata.title}
                      </p>
                      {hidden && (
                        <p className="mt-0.5 text-xs text-gray-500">已隐藏</p>
                      )}
                    </div>
                  </TableStickyCell>
                  <TableCell className="w-28">
                    <span className="inline-flex items-center gap-1.5 text-xs text-gray-700">
                      {workflow.metadata.type === "tabular" ? (
                        <Table2 className="h-3.5 w-3.5 text-violet-700" />
                      ) : (
                        <MessageSquare className="h-3.5 w-3.5 text-blue-700" />
                      )}
                      {workflow.metadata.type === "tabular" ? "表格" : "助手"}
                    </span>
                  </TableCell>
                  <TableCell className="w-36">
                    <span className="truncate text-xs text-gray-600">
                      {workflow.metadata.practice ?? "—"}
                    </span>
                  </TableCell>
                  <TableCell className="w-44">
                    <span className="truncate text-xs text-gray-600">
                      {workflow.metadata.jurisdictions?.join("、") || "—"}
                    </span>
                  </TableCell>
                  <TableCell className="w-28">
                    <span className="text-xs text-gray-600">
                      {workflow.is_system ? "内置" : "本地"}
                    </span>
                  </TableCell>
                  <TableCell
                    className="w-28"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <div className="flex justify-end gap-1">
                      {workflow.is_system ? (
                        <button
                          type="button"
                          disabled={hiddenPending}
                          onClick={(event) => {
                            event.stopPropagation();
                            void toggleHidden(workflow);
                          }}
                          className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-40"
                          title={
                            hiddenPending
                              ? "正在更新…"
                              : hidden
                                ? "取消隐藏"
                                : "隐藏"
                          }
                          aria-label={
                            hiddenPending
                              ? "正在更新内置工作流显示状态"
                              : hidden
                                ? "取消隐藏"
                                : "隐藏"
                          }
                        >
                          {hidden ? (
                            <Eye className="h-4 w-4" />
                          ) : (
                            <EyeOff className="h-4 w-4" />
                          )}
                        </button>
                      ) : editable ? (
                        <button
                          type="button"
                          disabled={deleteControlsLocked || deletePending}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (deleteControlsLocked) return;
                            setDeleteTarget(workflow);
                          }}
                          className="rounded p-1.5 text-red-500 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                          title={deletePending ? "正在删除…" : "删除工作流"}
                          aria-label={
                            deletePending ? "正在删除工作流" : "删除工作流"
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        )}
      </TableScrollArea>
      <VeraWorkflowFormModal
        key={createOpen ? "create-open" : "create-closed"}
        open={createOpen}
        mode="create"
        busy={createBusy}
        error={operationError}
        onClose={() => !createBusy && setCreateOpen(false)}
        onCreate={createWorkflow}
      />
      <ConfirmPopup
        open={deleteTarget !== null}
        title="删除工作流？"
        message={
          deleteTarget
            ? `“${deleteTarget.metadata.title}”将从本地工作区永久删除。`
            : undefined
        }
        confirmLabel="删除"
        confirmStatus={deleteBusy ? "loading" : "idle"}
        confirmDisabled={
          !deleteTarget ||
          deleteBusy ||
          deletePendingIds.includes(deleteTarget.id)
        }
        onConfirm={() => void deleteWorkflow()}
        onCancel={() => !deleteBusy && setDeleteTarget(null)}
      />
    </div>
  );
}
