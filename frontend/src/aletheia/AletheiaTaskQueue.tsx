"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Calendar,
  CalendarClock,
  Check,
  CircleAlert,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";
import {
  completeAletheiaTask,
  fetchAletheiaTaskCalendar,
  listAletheiaMatters,
  listAletheiaTasks,
  reopenAletheiaTask,
  type AletheiaMatterOverview,
  type AletheiaMatterTaskRecord,
  type AletheiaMatterTaskStatus,
} from "@/app/lib/aletheiaApi";
import { AletheiaShell } from "./AletheiaShell";
import { cn } from "@/lib/utils";

type DueGroup = "overdue" | "today" | "upcoming" | "completed";

type CalendarFeedback = {
  message: string;
  tone: "success" | "cancelled" | "error";
};

function startOfToday() {
  const value = new Date();
  value.setHours(0, 0, 0, 0);
  return value;
}

export function taskDueGroup(task: AletheiaMatterTaskRecord): DueGroup {
  if (task.status === "completed") return "completed";
  const due = new Date(task.due_at);
  const today = startOfToday();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (due < today) return "overdue";
  if (due < tomorrow) return "today";
  return "upcoming";
}

export function formatTaskDueDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

const groupLabels: Record<DueGroup, string> = {
  overdue: "Overdue",
  today: "Due today",
  upcoming: "Upcoming",
  completed: "Completed",
};

export function AletheiaTaskQueue() {
  const [status, setStatus] = useState<AletheiaMatterTaskStatus>("open");
  const [tasks, setTasks] = useState<AletheiaMatterTaskRecord[]>([]);
  const [matters, setMatters] = useState<AletheiaMatterOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [exportingCalendar, setExportingCalendar] = useState(false);
  const [calendarFeedback, setCalendarFeedback] =
    useState<CalendarFeedback | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const [taskRecords, matterRecords] = await Promise.all([
        listAletheiaTasks(status),
        listAletheiaMatters(),
      ]);
      setTasks(taskRecords);
      setMatters(matterRecords);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to load work queue",
      );
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    if (!calendarFeedback) return;
    const timeout = window.setTimeout(() => setCalendarFeedback(null), 3000);
    return () => window.clearTimeout(timeout);
  }, [calendarFeedback]);

  const matterById = useMemo(
    () => new Map(matters.map((matter) => [matter.id, matter])),
    [matters],
  );
  const grouped = useMemo(() => {
    const result = new Map<DueGroup, AletheiaMatterTaskRecord[]>();
    for (const task of [...tasks].sort((a, b) =>
      a.due_at.localeCompare(b.due_at),
    )) {
      const group = taskDueGroup(task);
      const current = result.get(group) ?? [];
      current.push(task);
      result.set(group, current);
    }
    return result;
  }, [tasks]);
  const visibleGroups: DueGroup[] =
    status === "completed" ? ["completed"] : ["overdue", "today", "upcoming"];

  async function changeTask(task: AletheiaMatterTaskRecord) {
    setSavingId(task.id);
    setError("");
    try {
      if (task.status === "open") await completeAletheiaTask(task.id);
      else await reopenAletheiaTask(task.id);
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to update task",
      );
    } finally {
      setSavingId(null);
    }
  }

  async function exportCalendar() {
    setExportingCalendar(true);
    setCalendarFeedback(null);
    try {
      const desktop = window.aletheiaDesktop;
      if (desktop?.saveTaskCalendar) {
        const result = await desktop.saveTaskCalendar({
          status,
          suggestedName: "Vera Work Queue.ics",
          openAfterSave: false,
        });
        setCalendarFeedback(
          result.canceled
            ? { message: "Export cancelled.", tone: "cancelled" }
            : { message: "Calendar exported.", tone: "success" },
        );
        return;
      }

      const blob = await fetchAletheiaTaskCalendar(status);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "Vera Work Queue.ics";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setCalendarFeedback({
        message: "Calendar exported.",
        tone: "success",
      });
    } catch (reason) {
      setCalendarFeedback({
        message:
          reason instanceof Error
            ? reason.message
            : "Unable to export calendar.",
        tone: "error",
      });
    } finally {
      setExportingCalendar(false);
    }
  }

  return (
    <AletheiaShell>
      <section className="min-h-full bg-white">
        <header className="border-b border-gray-200 px-6 py-6 lg:px-10">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-[22px] font-semibold text-gray-950">
                Work Queue
              </h1>
              <p className="mt-1 text-sm text-gray-500">
                Lawyer-confirmed deadlines that require action.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-4">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={exportingCalendar}
                  onClick={() => void exportCalendar()}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-gray-300 px-3 text-sm font-medium text-gray-700 hover:border-gray-400 hover:bg-gray-50 hover:text-gray-950 disabled:cursor-wait disabled:opacity-50"
                >
                  {exportingCalendar ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <Calendar className="h-4 w-4" />
                  )}
                  Export calendar
                </button>
                <span
                  role="status"
                  aria-live="polite"
                  className={cn(
                    "min-h-5 text-xs",
                    calendarFeedback?.tone === "success" && "text-emerald-700",
                    calendarFeedback?.tone === "cancelled" && "text-gray-500",
                    calendarFeedback?.tone === "error" && "text-red-700",
                  )}
                >
                  {calendarFeedback?.message}
                </span>
              </div>
              <div className="flex border-b border-gray-200" role="tablist">
                {(["open", "completed"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="tab"
                    aria-selected={status === item}
                    onClick={() => setStatus(item)}
                    className={cn(
                      "px-4 py-2 text-sm font-medium capitalize",
                      status === item
                        ? "border-b-2 border-gray-950 text-gray-950"
                        : "text-gray-500 hover:text-gray-900",
                    )}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </header>

        {error ? (
          <div className="border-b border-red-200 bg-red-50 px-6 py-3 text-sm text-red-700 lg:px-10">
            {error}
          </div>
        ) : null}

        <div className="px-6 py-6 lg:px-10">
          {loading ? (
            <div className="flex items-center gap-2 py-12 text-sm text-gray-500">
              <LoaderCircle className="h-4 w-4 animate-spin" /> Loading work
              queue
            </div>
          ) : tasks.length === 0 ? (
            <div className="border-y border-gray-200 py-14 text-center">
              <CalendarClock className="mx-auto h-5 w-5 text-gray-400" />
              <h2 className="mt-3 text-sm font-medium text-gray-900">
                {status === "open" ? "No open tasks" : "No completed tasks"}
              </h2>
              <p className="mx-auto mt-1 max-w-lg text-sm leading-6 text-gray-500">
                Confirm a procedural deadline inside a litigation matter, then
                add it to this queue.
              </p>
            </div>
          ) : (
            <div className="space-y-8">
              {visibleGroups.map((group) => {
                const rows = grouped.get(group) ?? [];
                if (rows.length === 0) return null;
                return (
                  <section key={group}>
                    <div className="mb-2 flex items-center gap-2">
                      {group === "overdue" ? (
                        <CircleAlert className="h-4 w-4 text-red-600" />
                      ) : null}
                      <h2 className="text-xs font-semibold uppercase text-gray-500">
                        {groupLabels[group]}
                      </h2>
                      <span className="text-xs text-gray-400">
                        {rows.length}
                      </span>
                    </div>
                    <div className="border-t border-gray-200">
                      {rows.map((task) => {
                        const matter = matterById.get(task.matter_id);
                        return (
                          <article
                            key={task.id}
                            className="grid gap-3 border-b border-gray-200 py-4 md:grid-cols-[minmax(0,1fr)_180px_110px_36px] md:items-center"
                          >
                            <div className="min-w-0">
                              <Link
                                href={`/aletheia/matters/${task.matter_id}/litigation?view=procedure&focus=${encodeURIComponent(`task:${task.id}`)}`}
                                className="text-sm font-medium text-gray-950 hover:underline"
                              >
                                {task.title}
                              </Link>
                              <p className="mt-1 truncate text-xs text-gray-500">
                                {matter?.title ?? "Matter"}
                                {task.note ? ` · ${task.note}` : ""}
                              </p>
                            </div>
                            <time
                              className={cn(
                                "text-sm text-gray-600",
                                group === "overdue" && "text-red-700",
                              )}
                            >
                              {formatTaskDueDate(task.due_at)}
                            </time>
                            <span className="text-xs capitalize text-gray-500">
                              {task.priority} priority
                            </span>
                            <button
                              type="button"
                              disabled={savingId === task.id}
                              onClick={() => void changeTask(task)}
                              className="grid h-8 w-8 place-items-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-950 disabled:opacity-40"
                              aria-label={
                                task.status === "open"
                                  ? "Complete task"
                                  : "Reopen task"
                              }
                              title={
                                task.status === "open"
                                  ? "Complete task"
                                  : "Reopen task"
                              }
                            >
                              {savingId === task.id ? (
                                <LoaderCircle className="h-4 w-4 animate-spin" />
                              ) : task.status === "open" ? (
                                <Check className="h-4 w-4" />
                              ) : (
                                <RotateCcw className="h-4 w-4" />
                              )}
                            </button>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </AletheiaShell>
  );
}
