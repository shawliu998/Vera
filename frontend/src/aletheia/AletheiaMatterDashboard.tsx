"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CalendarClock,
  CircleAlert,
  Database,
  FileCheck2,
  RefreshCw,
  Scale,
  ShieldCheck,
} from "lucide-react";
import { NewMatterButton } from "./NewMatterButton";
import {
  listAletheiaMatters,
  listAletheiaTasks,
  type AletheiaMatterOverview,
  type AletheiaMatterTaskRecord,
} from "@/app/lib/aletheiaApi";
import { cn } from "@/lib/utils";
import { formatTaskDueDate, taskDueGroup } from "./AletheiaTaskQueue";

type MatterQueueItem = {
  id: string;
  title: string;
  template: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  clientOrProject?: string;
  objective: string;
  riskLevel?: string;
  templateName: string;
  documentCount: number;
  evidenceCount: number;
  reviewCount: number;
  auditEventCount: number;
  href: string;
};

function riskClass(risk?: string | null) {
  if (risk === "high") return "text-red-600";
  if (risk === "medium") return "text-amber-700";
  return "text-gray-500";
}

function statusClass(status: string) {
  if (status === "needs_review") return "text-amber-700";
  if (status === "completed") return "text-gray-500";
  return "text-gray-600";
}

function titleize(value: string) {
  return value.replaceAll("_", " ");
}

function templateName(templateId: string) {
  if (templateId === "civil_litigation") return "Civil Litigation";
  return titleize(templateId);
}

function remoteToQueueItem(matter: AletheiaMatterOverview): MatterQueueItem {
  return {
    id: matter.id,
    title: matter.title,
    template: matter.template,
    status: matter.status === "archived" ? "completed" : matter.status,
    createdAt: matter.created_at,
    updatedAt: matter.updated_at,
    clientOrProject: matter.client_or_project ?? undefined,
    objective: matter.objective,
    riskLevel: matter.risk_level ?? undefined,
    templateName: templateName(matter.template),
    documentCount: matter.document_count,
    evidenceCount: matter.evidence_count,
    reviewCount: matter.review_count,
    auditEventCount: matter.audit_event_count,
    href: `/aletheia/matters/${matter.id}/litigation?view=overview`,
  };
}

export function AletheiaMatterDashboard({
  initialNewMatterOpen,
}: {
  initialNewMatterOpen: boolean;
}) {
  const [apiMatters, setApiMatters] = useState<MatterQueueItem[]>([]);
  const [openTasks, setOpenTasks] = useState<AletheiaMatterTaskRecord[]>([]);
  const [apiState, setApiState] = useState<
    "checking" | "connected" | "unavailable"
  >("checking");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function loadMatters() {
      setApiState("checking");
      setApiMatters([]);
      setOpenTasks([]);
      try {
        const [records, tasks] = await Promise.all([
          listAletheiaMatters(),
          listAletheiaTasks("open"),
        ]);
        if (cancelled) return;
        setApiMatters(records.map(remoteToQueueItem));
        setOpenTasks(tasks);
        setApiState("connected");
      } catch {
        if (!cancelled) setApiState("unavailable");
      }
    }
    void loadMatters();
    return () => {
      cancelled = true;
    };
  }, [retryKey]);

  const matters = apiMatters;

  const totalEvidence = matters.reduce(
    (sum, matter) => sum + matter.evidenceCount,
    0,
  );
  const totalReviews = matters.reduce(
    (sum, matter) => sum + matter.reviewCount,
    0,
  );
  const connected = apiState === "connected";
  const matterById = new Map(matters.map((matter) => [matter.id, matter]));

  return (
    <section className="flex min-h-full flex-col bg-[#fbfbfc]">
      <div className="border-b border-gray-200 bg-white px-5 py-4 md:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-[22px] font-semibold leading-7 text-gray-950">
              Matters
            </h1>
            <p className="mt-1 text-xs text-gray-500">
              {connected
                ? "Local records connected."
                : apiState === "checking"
                  ? "Connecting to the local service..."
                  : "Local records are unavailable."}
            </p>
          </div>
          <div className="flex w-fit items-center gap-3">
            {connected && (
              <div className="hidden h-9 items-center gap-2 text-sm font-medium text-gray-700 md:flex">
                <Database className="h-3.5 w-3.5 text-emerald-600" />
                Local store
              </div>
            )}
            {connected && matters.length > 0 && (
              <NewMatterButton initialOpen={initialNewMatterOpen} />
            )}
          </div>
        </div>

        {connected && (
          <div className="mt-4 grid overflow-hidden border border-gray-200 bg-white md:grid-cols-4">
          {[
            {
              label: "Matters",
              value: matters.length,
              icon: Scale,
            },
            {
              label: "Evidence",
              value: totalEvidence,
              icon: FileCheck2,
            },
            {
              label: "Reviews",
              value: totalReviews,
              icon: ShieldCheck,
            },
            {
              label: "Open tasks",
              value: openTasks.length,
              icon: CalendarClock,
            },
          ].map((item) => (
            <div
              key={item.label}
              className="flex items-center justify-between border-b border-gray-200/60 px-3.5 py-2.5 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0"
            >
              <div>
                <p className="text-[11px] font-medium text-gray-500">
                  {item.label}
                </p>
                <p className="mt-0.5 text-lg font-semibold text-gray-950">
                  {item.value}
                </p>
              </div>
              <item.icon className="h-4 w-4 stroke-[1.8] text-gray-500" />
            </div>
          ))}
          </div>
        )}
      </div>

      {connected && (
        <div className="flex h-12 items-center gap-4 border-b border-gray-100 bg-white px-5 text-sm md:px-8">
          <div className="flex items-center gap-4">
          <span className="border-b border-gray-950 py-3 text-sm font-medium text-gray-950">
            All Matters
          </span>
          </div>
        </div>
      )}

      {apiState === "checking" && (
        <div className="px-5 py-8 text-sm text-gray-500 md:px-8">
          Connecting to the local service...
        </div>
      )}

      {apiState === "unavailable" && (
        <div className="px-5 py-8 md:px-8">
          <div
            role="alert"
            data-testid="matters-service-unavailable"
            className="max-w-2xl border border-gray-300 bg-white p-5"
          >
            <div className="flex items-start gap-3">
              <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-red-700" />
              <div>
                <h2 className="text-sm font-semibold text-gray-950">
                  Local service unavailable
                </h2>
                <p className="mt-1 text-sm leading-6 text-gray-600">
                  Vera could not load local matters and has not substituted demo
                  records. Reconnect the local service, then retry.
                </p>
                <button
                  type="button"
                  onClick={() => setRetryKey((value) => value + 1)}
                  className="mt-4 inline-flex h-9 items-center gap-2 border border-gray-300 bg-white px-3 text-sm font-medium text-gray-800 hover:bg-gray-50"
                >
                  <RefreshCw className="h-4 w-4" />
                  Retry
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {connected && (
        <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_340px]">
        <section className="min-w-0 overflow-x-auto">
          <div className="min-w-0 md:min-w-[900px]">
            <div className="flex h-8 items-center border-b border-gray-200/80 bg-[#f6f7f8] pr-8 text-xs font-semibold text-gray-500">
              <div className="w-8 shrink-0" />
              <div className="flex-1 min-w-0 pl-2 pr-4">Name</div>
              <div className="hidden w-52 shrink-0 md:block">Template</div>
              <div className="hidden w-24 shrink-0 md:block">Docs</div>
              <div className="hidden w-24 shrink-0 md:block">Evidence</div>
              <div className="hidden w-28 shrink-0 md:block">Status</div>
              <div className="w-8 shrink-0" />
            </div>
            <div>
              {matters.length === 0 && (
                <div className="px-10 py-16 text-center">
                  <h2 className="text-base font-semibold text-gray-900">
                    No matters yet
                  </h2>
                  <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-gray-500">
                    Create a local matter to import documents, confirm facts,
                    track deadlines, and prepare reviewable work products.
                  </p>
                  <div className="mt-5 flex justify-center">
                    <NewMatterButton />
                  </div>
                </div>
              )}
              {matters.map((matter) => (
                <Link
                  key={matter.id}
                  href={matter.href}
                  className="aletheia-matter-row group flex h-16 items-center border-b border-gray-100 pr-8 transition-colors hover:bg-white"
                >
                  <div className="flex w-8 shrink-0 justify-center">
                    <Scale className="h-3.5 w-3.5 text-gray-300 group-hover:text-gray-500" />
                  </div>
                  <div className="min-w-0 flex-1 pl-2 pr-4">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm text-gray-800">
                        {matter.title}
                      </span>
                      <span
                        className={cn(
                          "text-[11px] font-medium",
                          riskClass(matter.riskLevel),
                        )}
                      >
                        {matter.riskLevel ?? "low"}
                      </span>
                      <span className="text-[11px] text-gray-400">local</span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-gray-400">
                      {matter.objective}
                    </p>
                  </div>
                  <div className="hidden w-52 shrink-0 truncate text-sm text-gray-500 md:block">
                    {matter.templateName}
                  </div>
                  <div className="hidden w-24 shrink-0 text-sm text-gray-500 md:block">
                    {matter.documentCount}
                  </div>
                  <div className="hidden w-24 shrink-0 text-sm text-gray-500 md:block">
                    {matter.evidenceCount}
                  </div>
                  <div className="hidden w-28 shrink-0 md:block">
                    <span
                      className={cn(
                        "text-xs font-medium",
                        statusClass(matter.status),
                      )}
                    >
                      {titleize(matter.status)}
                    </span>
                  </div>
                  <ArrowRight className="h-4 w-8 shrink-0 text-gray-300 transition-colors group-hover:text-gray-600" />
                </Link>
              ))}
            </div>
          </div>
        </section>

        <aside className="border-l border-gray-100 bg-white px-5 py-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-900">Work Queue</h2>
            <Link
              href="/aletheia/tasks"
              className="text-xs text-gray-400 hover:text-gray-900"
            >
              View all
            </Link>
          </div>
          <div className="mt-4">
            {openTasks.length === 0 && (
              <p className="border-y border-gray-100 py-6 text-sm text-gray-400">
                No open tasks.
              </p>
            )}
            {openTasks.slice(0, 6).map((task) => {
              const matter = matterById.get(task.matter_id);
              const dueGroup = taskDueGroup(task);
              return (
                <Link
                  key={task.id}
                  href={`/aletheia/matters/${task.matter_id}/litigation?view=procedure&focus=${encodeURIComponent(`task:${task.id}`)}`}
                  className="block border-b border-gray-100 py-4 first:pt-0 last:border-b-0"
                >
                  <p className="mt-2 text-sm font-medium leading-5 text-gray-800">
                    {task.title}
                  </p>
                  <div className="mt-1 flex items-center justify-between gap-3 text-xs">
                    <span className="truncate text-gray-400">
                      {matter?.title ?? "Matter"}
                    </span>
                    <time
                      className={cn(
                        "shrink-0 text-gray-500",
                        dueGroup === "overdue" && "text-red-700",
                        dueGroup === "today" && "text-amber-700",
                      )}
                    >
                      {formatTaskDueDate(task.due_at)}
                    </time>
                  </div>
                </Link>
              );
            })}
          </div>
        </aside>
        </div>
      )}
    </section>
  );
}
