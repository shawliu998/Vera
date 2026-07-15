"use client";

/**
 * Execution surface adapted from the selection/configuration hierarchy in
 * Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238
 * frontend/src/app/components/workflows/UseWorkflowModal.tsx.
 *
 * Unlike Mike's chat hand-off, Vera binds the same UI hierarchy to the local
 * durable workflow run API. No client timer advances state: every transition
 * displayed here is read back from the encrypted workspace database.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  Table2,
  XCircle,
} from "lucide-react";

import { useVeraSettings } from "@/app/contexts/VeraSettingsContext";
import { useI18n } from "@/app/i18n";
import { listVeraProjects, VeraApiError } from "@/app/lib/veraApi";
import type { VeraProjectWire } from "@/app/lib/veraWireTypes";
import {
  cancelVeraWorkflowRun,
  getVeraWorkflowExecutionCapabilities,
  getVeraWorkflowRun,
  listVeraWorkflowRuns,
  retryVeraWorkflowRun,
  startVeraWorkflowRun,
  type VeraPreparedWorkflowRun,
  type VeraWorkflow,
  type VeraWorkflowExecutionCapabilities,
  type VeraWorkflowJson,
  type VeraWorkflowRun,
  type VeraWorkflowRunDetail,
  type VeraWorkflowRunStatus,
  type VeraWorkflowStepRun,
  type VeraWorkflowStepStatus,
} from "@/app/lib/veraWorkflowApi";

const ACTIVE_RUN_STATUSES = new Set<VeraWorkflowRunStatus>([
  "queued",
  "waiting",
  "running",
]);
export const WORKFLOW_RUN_POLL_DELAY_MS = 1_200;
export const WORKFLOW_RUN_POLL_MAX_RETRY_DELAY_MS = 12_000;
export const WORKFLOW_RUN_POLL_MAX_FAILURES = 5;

function isRetryablePollError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!(error instanceof VeraApiError)) return false;
  return (
    error.retryable ||
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    (error.status >= 500 && error.status < 600)
  );
}

type WorkflowRunPollOptions = {
  load: (signal: AbortSignal) => Promise<VeraWorkflowRunDetail>;
  apply: (detail: VeraWorkflowRunDetail) => void;
  terminal: (detail: VeraWorkflowRunDetail) => void;
  reportError: (error: unknown) => void;
  clearError: () => void;
  schedule: (callback: () => void, delayMs: number) => number;
  cancelSchedule: (handle: number) => void;
};

/** Exported to prove finite, abortable, database-backed polling in tests. */
export function createVeraWorkflowRunPollCoordinator(
  options: WorkflowRunPollOptions,
) {
  let stopped = true;
  let timer: number | null = null;
  let request: AbortController | null = null;
  let failures = 0;

  const schedule = (delay: number) => {
    if (stopped || timer !== null) return;
    timer = options.schedule(() => {
      timer = null;
      void poll();
    }, delay);
  };

  const poll = async () => {
    if (stopped || request !== null) return;
    const controller = new AbortController();
    request = controller;
    try {
      const detail = await options.load(controller.signal);
      if (stopped || controller.signal.aborted) return;
      failures = 0;
      options.clearError();
      options.apply(detail);
      if (ACTIVE_RUN_STATUSES.has(detail.run.status)) {
        schedule(WORKFLOW_RUN_POLL_DELAY_MS);
      } else {
        options.terminal(detail);
      }
    } catch (error) {
      if (stopped || controller.signal.aborted) return;
      failures += 1;
      if (
        isRetryablePollError(error) &&
        failures < WORKFLOW_RUN_POLL_MAX_FAILURES
      ) {
        schedule(
          Math.min(
            WORKFLOW_RUN_POLL_DELAY_MS * 2 ** failures,
            WORKFLOW_RUN_POLL_MAX_RETRY_DELAY_MS,
          ),
        );
      } else {
        options.reportError(error);
      }
    } finally {
      if (request === controller) request = null;
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(WORKFLOW_RUN_POLL_DELAY_MS);
    },
    refreshNow() {
      if (stopped || request !== null) return;
      if (timer !== null) {
        options.cancelSchedule(timer);
        timer = null;
      }
      void poll();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) options.cancelSchedule(timer);
      timer = null;
      request?.abort();
      request = null;
    },
  };
}

function statusTone(status: VeraWorkflowRunStatus | VeraWorkflowStepStatus) {
  if (status === "complete") return "bg-emerald-50 text-emerald-700";
  if (status === "failed") return "bg-red-50 text-red-700";
  if (status === "cancelled" || status === "interrupted") {
    return "bg-amber-50 text-amber-700";
  }
  if (status === "skipped") return "bg-gray-100 text-gray-500";
  return "bg-blue-50 text-blue-700";
}

function StatusIcon({
  status,
}: {
  status: VeraWorkflowRunStatus | VeraWorkflowStepStatus;
}) {
  const className = "h-3.5 w-3.5 shrink-0";
  if (status === "complete") return <CheckCircle2 className={className} />;
  if (status === "failed") return <XCircle className={className} />;
  if (status === "running") return <Loader2 className={`${className} animate-spin`} />;
  if (status === "queued" || status === "waiting") {
    return <Clock3 className={className} />;
  }
  return <Circle className={className} />;
}

function boundedJson(
  value: VeraWorkflowJson | null,
  truncatedLabel: string,
): string {
  if (value === null) return "";
  const output = JSON.stringify(value, null, 2);
  return output.length <= 50_000
    ? output
    : `${output.slice(0, 50_000)}\n${truncatedLabel}`;
}

function extractContent(value: VeraWorkflowJson | null): string | null {
  if (typeof value === "string") return value;
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  for (const key of ["content", "assistant_content", "final_content"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return null;
}

function mergeRun(runs: VeraWorkflowRun[], run: VeraWorkflowRun) {
  return [run, ...runs.filter((candidate) => candidate.id !== run.id)].sort(
    (left, right) =>
      right.created_at.localeCompare(left.created_at) ||
      right.id.localeCompare(left.id),
  );
}

function idempotencyKey(prefix: "run" | "retry") {
  return `vera-workflow-${prefix}-${crypto.randomUUID()}`;
}

export function VeraWorkflowRunPanel({
  workflow,
  initialProjectId = null,
  boundProjectId = null,
  configuredModelProfileId = null,
}: {
  workflow: VeraWorkflow;
  initialProjectId?: string | null;
  boundProjectId?: string | null;
  configuredModelProfileId?: string | null;
}) {
  const router = useRouter();
  const { t, formatDate, errorMessage } = useI18n();
  const { models, settings, loadState: settingsLoadState } = useVeraSettings();
  const [capabilities, setCapabilities] =
    useState<VeraWorkflowExecutionCapabilities | null>(null);
  const [projects, setProjects] = useState<VeraProjectWire[]>([]);
  const [runs, setRuns] = useState<VeraWorkflowRun[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<VeraWorkflowRunDetail | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedModelId, setSelectedModelId] = useState("");
  const [additionalInstructions, setAdditionalInstructions] = useState("");
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<
    "run" | "cancel" | "retry" | null
  >(null);
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const [operationFailure, setOperationFailure] = useState<unknown>(null);
  const pollRef = useRef<ReturnType<
    typeof createVeraWorkflowRunPollCoordinator
  > | null>(null);

  const readyModels = useMemo(
    () =>
      models.filter(
        (model) =>
          model.enabled &&
          model.availability.selectable &&
          model.connection_test.status === "passed",
      ),
    [models],
  );

  useEffect(() => {
    if (configuredModelProfileId) {
      setSelectedModelId(
        readyModels.some((item) => item.id === configuredModelProfileId)
          ? configuredModelProfileId
          : "",
      );
      return;
    }
    if (selectedModelId && readyModels.some((item) => item.id === selectedModelId)) {
      return;
    }
    const preferred = readyModels.find(
      (item) => item.id === settings?.default_model_profile_id,
    );
    setSelectedModelId(preferred?.id ?? readyModels[0]?.id ?? "");
  }, [
    configuredModelProfileId,
    readyModels,
    selectedModelId,
    settings?.default_model_profile_id,
  ]);

  const loadInitial = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadFailure(null);
      try {
        const [nextCapabilities, nextProjects, page] = await Promise.all([
          getVeraWorkflowExecutionCapabilities(signal),
          listVeraProjects(signal),
          listVeraWorkflowRuns(workflow.id, { limit: 25 }, signal),
        ]);
        if (signal?.aborted) return;
        setCapabilities(nextCapabilities);
        const activeProjects = nextProjects.filter(
          (project) => project.status === "active",
        );
        setProjects(activeProjects);
        setRuns(page.items);
        setNextCursor(page.next_cursor);
        setSelectedProjectId((current) => {
          if (boundProjectId) {
            return activeProjects.some(
              (project) => project.id === boundProjectId,
            )
              ? boundProjectId
              : "";
          }
          if (current && activeProjects.some((project) => project.id === current)) {
            return current;
          }
          const preferredProjectId = initialProjectId;
          return preferredProjectId &&
            activeProjects.some((project) => project.id === preferredProjectId)
            ? preferredProjectId
            : "";
        });
        setSelectedRunId((current) =>
          current && page.items.some((run) => run.id === current)
            ? current
            : (page.items[0]?.id ?? null),
        );
      } catch (error) {
        if (signal?.aborted) return;
        setCapabilities(null);
        setProjects([]);
        setRuns([]);
        setNextCursor(null);
        setSelectedRunId(null);
        setDetail(null);
        setLoadFailure(error);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [boundProjectId, initialProjectId, workflow.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadInitial(controller.signal);
    return () => controller.abort();
  }, [loadInitial]);

  const applyDetail = useCallback((next: VeraWorkflowRunDetail) => {
    setDetail(next);
    setRuns((current) => mergeRun(current, next.run));
  }, []);

  useEffect(() => {
    pollRef.current?.stop();
    pollRef.current = null;
    if (!selectedRunId) {
      setDetail(null);
      return;
    }
    setDetail((current) =>
      current?.run.id === selectedRunId ? current : null,
    );
    setOperationFailure(null);
    const coordinator = createVeraWorkflowRunPollCoordinator({
      load: (signal) => getVeraWorkflowRun(selectedRunId, signal),
      apply: applyDetail,
      terminal: applyDetail,
      reportError: setOperationFailure,
      clearError: () => setOperationFailure(null),
      schedule: (callback, delay) => window.setTimeout(callback, delay),
      cancelSchedule: (handle) => window.clearTimeout(handle),
    });
    pollRef.current = coordinator;
    coordinator.start();
    coordinator.refreshNow();
    return () => {
      coordinator.stop();
      if (pollRef.current === coordinator) pollRef.current = null;
    };
  }, [applyDetail, selectedRunId]);

  async function startRun() {
    if (
      busyAction ||
      workflow.metadata.type !== "assistant" ||
      capabilities?.execution_enabled !== true ||
      !selectedModelId
    ) {
      return;
    }
    setBusyAction("run");
    setOperationFailure(null);
    try {
      const input = additionalInstructions.trim()
        ? { additional_instructions: additionalInstructions.trim() }
        : undefined;
      const prepared = await startVeraWorkflowRun(workflow.id, {
        idempotency_key: idempotencyKey("run"),
        ...(selectedProjectId ? { project_id: selectedProjectId } : {}),
        model_profile_id: selectedModelId,
        ...(input ? { input_binding: input } : {}),
      });
      acceptPrepared(prepared);
      setAdditionalInstructions("");
    } catch (error) {
      setOperationFailure(error);
    } finally {
      setBusyAction(null);
    }
  }

  function acceptPrepared(prepared: VeraPreparedWorkflowRun) {
    setRuns((current) => mergeRun(current, prepared.run));
    setDetail({ run: prepared.run, steps: prepared.steps });
    setSelectedRunId(prepared.run.id);
  }

  async function cancelRun() {
    if (!detail || busyAction || !ACTIVE_RUN_STATUSES.has(detail.run.status)) return;
    setBusyAction("cancel");
    setOperationFailure(null);
    try {
      applyDetail(await cancelVeraWorkflowRun(detail.run.id));
    } catch (error) {
      setOperationFailure(error);
    } finally {
      setBusyAction(null);
    }
  }

  async function retryRun() {
    if (
      !detail ||
      busyAction ||
      detail.run.status !== "failed" ||
      detail.run.error?.retryable !== true
    ) {
      return;
    }
    setBusyAction("retry");
    setOperationFailure(null);
    try {
      acceptPrepared(
        await retryVeraWorkflowRun(
          detail.run.id,
          idempotencyKey("retry"),
        ),
      );
    } catch (error) {
      setOperationFailure(error);
    } finally {
      setBusyAction(null);
    }
  }

  async function loadMoreRuns() {
    if (!nextCursor || historyLoading) return;
    setHistoryLoading(true);
    setOperationFailure(null);
    try {
      const page = await listVeraWorkflowRuns(workflow.id, {
        cursor: nextCursor,
        limit: 25,
      });
      setRuns((current) => {
        const byId = new Map(current.map((run) => [run.id, run]));
        page.items.forEach((run) => byId.set(run.id, run));
        return [...byId.values()].sort((left, right) =>
          right.created_at.localeCompare(left.created_at),
        );
      });
      setNextCursor(page.next_cursor);
    } catch (error) {
      setOperationFailure(error);
    } finally {
      setHistoryLoading(false);
    }
  }

  const failureText = (failure: unknown, fallback: string) => {
    if (failure instanceof VeraApiError) {
      return errorMessage({ code: failure.code, status: failure.status });
    }
    return fallback;
  };

  if (workflow.metadata.type === "tabular") {
    return (
      <aside className="rounded-2xl border border-violet-100 bg-violet-50/60 p-5">
        <div className="flex items-start gap-3">
          <Table2 className="mt-0.5 h-5 w-5 shrink-0 text-violet-700" />
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-gray-900">
              {t("workflows.tabular.title")}
            </h2>
            <p className="mt-1 text-xs leading-5 text-gray-600">
              {t("workflows.tabular.body")}
            </p>
            <button
              type="button"
              onClick={() => router.push("/projects")}
              className="mt-4 rounded-full bg-violet-700 px-4 py-2 text-xs font-medium text-white"
            >
              {t("workflows.tabular.action")}
            </button>
          </div>
        </div>
      </aside>
    );
  }

  if (loading) {
    return (
      <aside className="flex min-h-72 items-center justify-center rounded-2xl border border-gray-100 bg-white text-sm text-gray-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t("workflows.execution.restoring")}
      </aside>
    );
  }

  if (loadFailure) {
    return (
      <aside className="rounded-2xl border border-red-100 bg-red-50/60 p-5">
        <AlertCircle className="h-5 w-5 text-red-600" />
        <p role="alert" className="mt-3 text-sm text-red-700">
          {failureText(loadFailure, t("workflows.errors.load"))}
        </p>
        <button
          type="button"
          onClick={() => void loadInitial()}
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-gray-900 px-4 py-2 text-xs font-medium text-white"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t("common.actions.retry")}
        </button>
      </aside>
    );
  }

  const canRun =
    capabilities?.execution_enabled === true &&
    settingsLoadState === "ready" &&
    readyModels.length > 0 &&
    Boolean(selectedModelId) &&
    busyAction === null;
  const configuredModelUnavailable = Boolean(
    configuredModelProfileId &&
      !readyModels.some((model) => model.id === configuredModelProfileId),
  );
  const selectedOutput = extractContent(detail?.run.output ?? null);

  return (
    <aside className="flex min-h-0 flex-col rounded-2xl border border-gray-100 bg-white shadow-sm">
      <div className="border-b border-gray-100 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-gray-900">
              {t("workflows.execution.title")}
            </h2>
            <p className="mt-1 text-xs text-gray-500">
              {t("workflows.execution.localDurable")}
            </p>
          </div>
          <button
            type="button"
            disabled={!canRun}
            onClick={() => void startRun()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-gray-950 px-3.5 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busyAction === "run" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {t("workflows.run")}
          </button>
        </div>

        {capabilities?.execution_enabled !== true && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {t("workflows.execution.unavailable")}
          </p>
        )}
        {readyModels.length === 0 && (
          <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {t("workflows.execution.noReadyModel")}
            <button
              type="button"
              onClick={() => router.push("/settings/models")}
              className="ml-2 font-medium underline underline-offset-2"
            >
              {t("workflows.execution.openModels")}
            </button>
          </div>
        )}
        {readyModels.length > 0 && configuredModelUnavailable && (
          <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {t("workflows.execution.configuredModelUnavailable")}
            <button
              type="button"
              onClick={() => router.push("/settings/models")}
              className="ml-2 font-medium underline underline-offset-2"
            >
              {t("workflows.execution.openModels")}
            </button>
          </div>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          <label className="min-w-0 text-xs font-medium text-gray-700">
            {t("workflows.projectOptional")}
            <select
              value={selectedProjectId}
              disabled={Boolean(boundProjectId)}
              onChange={(event) => setSelectedProjectId(event.target.value)}
              className="mt-1.5 h-9 w-full min-w-0 rounded-lg border border-gray-200 bg-white px-2 text-xs outline-none focus:border-gray-500 disabled:bg-gray-50"
            >
              <option value="">{t("workflows.execution.noProject")}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0 text-xs font-medium text-gray-700">
            {t("workflows.execution.model")}
            <select
              value={selectedModelId}
              onChange={(event) => setSelectedModelId(event.target.value)}
              disabled={
                readyModels.length === 0 || Boolean(configuredModelProfileId)
              }
              className="mt-1.5 h-9 w-full min-w-0 rounded-lg border border-gray-200 bg-white px-2 text-xs outline-none focus:border-gray-500 disabled:bg-gray-50"
            >
              <option value="" disabled>
                {t("workflows.execution.chooseModel")}
              </option>
              {readyModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name} · {model.model}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="mt-3 block text-xs font-medium text-gray-700">
          {t("workflows.execution.additionalInput")}
          <textarea
            value={additionalInstructions}
            onChange={(event) => setAdditionalInstructions(event.target.value)}
            maxLength={20_000}
            rows={3}
            placeholder={t("workflows.execution.additionalInputPlaceholder")}
            className="mt-1.5 w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs leading-5 outline-none focus:border-gray-500"
          />
        </label>
      </div>

      {operationFailure !== null && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p role="alert">
            {failureText(operationFailure, t("workflows.errors.run"))}
          </p>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(10rem,0.9fr)_minmax(14rem,1.1fr)] divide-y divide-gray-100 overflow-hidden xl:grid-cols-[minmax(11rem,0.72fr)_minmax(15rem,1.28fr)] xl:grid-rows-1 xl:divide-x xl:divide-y-0">
        <section className="min-h-0 overflow-y-auto p-3">
          <h3 className="px-1 text-xs font-semibold text-gray-500">
            {t("workflows.history")}
          </h3>
          {runs.length === 0 ? (
            <p className="px-1 py-8 text-center text-xs text-gray-400">
              {t("workflows.execution.noRuns")}
            </p>
          ) : (
            <div className="mt-2 space-y-1">
              {runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => setSelectedRunId(run.id)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors ${
                    selectedRunId === run.id
                      ? "bg-gray-100"
                      : "hover:bg-gray-50"
                  }`}
                >
                  <span className={`rounded-full p-1 ${statusTone(run.status)}`}>
                    <StatusIcon status={run.status} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-gray-700">
                      {t(`workflows.status.${run.status}`)}
                    </span>
                    <span className="block truncate text-[11px] text-gray-400">
                      {formatDate(run.created_at)}
                    </span>
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 text-gray-300" />
                </button>
              ))}
              {nextCursor && (
                <button
                  type="button"
                  disabled={historyLoading}
                  onClick={() => void loadMoreRuns()}
                  className="flex w-full items-center justify-center gap-1.5 py-2 text-xs font-medium text-gray-500 hover:text-gray-800 disabled:opacity-40"
                >
                  {historyLoading && <Loader2 className="h-3 w-3 animate-spin" />}
                  {t("workflows.execution.loadMore")}
                </button>
              )}
            </div>
          )}
        </section>

        <section className="min-h-0 overflow-y-auto p-4">
          {!detail ? (
            <p className="py-10 text-center text-xs text-gray-400">
              {t("workflows.execution.selectRun")}
            </p>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium ${statusTone(detail.run.status)}`}
                  >
                    <StatusIcon status={detail.run.status} />
                    {t(`workflows.status.${detail.run.status}`)}
                  </span>
                  {detail.run.retry_of_run_id && (
                    <span className="text-[11px] text-gray-400">
                      {t("workflows.execution.retryRun")}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {ACTIVE_RUN_STATUSES.has(detail.run.status) && (
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() => void cancelRun()}
                      className="inline-flex items-center gap-1 rounded-full border border-gray-200 px-2.5 py-1.5 text-[11px] font-medium text-gray-600 disabled:opacity-40"
                    >
                      {busyAction === "cancel" ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Square className="h-3 w-3" />
                      )}
                      {t("workflows.execution.cancel")}
                    </button>
                  )}
                  {detail.run.status === "failed" &&
                    detail.run.error?.retryable === true && (
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => void retryRun()}
                        className="inline-flex items-center gap-1 rounded-full bg-gray-900 px-2.5 py-1.5 text-[11px] font-medium text-white disabled:opacity-40"
                      >
                        {busyAction === "retry" ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3 w-3" />
                        )}
                        {t("workflows.runAgain")}
                      </button>
                    )}
                </div>
              </div>

              {detail.run.error && (
                <div className="rounded-lg bg-red-50 px-3 py-2">
                  <p className="text-xs font-medium text-red-800">
                    {errorMessage({ code: detail.run.error.code })}
                  </p>
                  <p className="mt-1 text-[11px] text-red-600">
                    {detail.run.error.code}
                  </p>
                </div>
              )}

              <div>
                <h4 className="text-xs font-semibold text-gray-600">
                  {t("workflows.steps")}
                </h4>
                <div className="mt-2 space-y-2">
                  {detail.steps.map((step) => (
                    <WorkflowStepRow key={step.id} step={step} />
                  ))}
                </div>
              </div>

              {detail.run.output !== null && (
                <div>
                  <h4 className="text-xs font-semibold text-gray-600">
                    {t("workflows.execution.output")}
                  </h4>
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-gray-950 px-3 py-3 text-[11px] leading-5 text-gray-100">
                    {selectedOutput ??
                      boundedJson(
                        detail.run.output,
                        t("workflows.execution.truncated"),
                      )}
                  </pre>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}

function WorkflowStepRow({ step }: { step: VeraWorkflowStepRun }) {
  const { t, errorMessage } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50/60">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left"
      >
        <span className={`rounded-full p-1 ${statusTone(step.status)}`}>
          <StatusIcon status={step.status} />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-gray-700">
          {step.step.title}
          <code
            title={step.step.id}
            className="ml-2 text-[9px] font-normal text-gray-400"
          >
            {step.step.id}
          </code>
        </span>
        <span className="shrink-0 text-[10px] text-gray-400">
          {t("workflows.execution.attempt", { attempt: step.attempt })}
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-gray-400" />
        )}
      </button>
      {open && (
        <div className="space-y-3 border-t border-gray-100 px-3 py-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              {t("workflows.execution.stepInput")}
            </p>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-5 text-gray-600">
              {boundedJson(step.input, t("workflows.execution.truncated"))}
            </pre>
          </div>
          {step.error ? (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-red-400">
                {t("workflows.execution.stepError")}
              </p>
            <p className="text-[11px] leading-5 text-red-700">
              {errorMessage({ code: step.error.code })}
            </p>
            </div>
          ) : step.output !== null ? (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                {t("workflows.execution.stepOutput")}
              </p>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-5 text-gray-600">
                {boundedJson(
                  step.output,
                  t("workflows.execution.truncated"),
                )}
              </pre>
            </div>
          ) : (
            <p className="text-[10px] text-gray-400">
              {t("workflows.execution.stepOutputPending")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
