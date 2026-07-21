"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
    AlertCircle,
    ArrowRight,
    CheckCircle2,
    Circle,
    Clock3,
    Loader2,
    Plus,
} from "lucide-react";
import { MODELS } from "@/app/components/assistant/ModelToggle";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { TaskSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
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
import type { Project } from "@/app/components/shared/types";
import { listAgentTasks } from "@/app/lib/agentClient";
import { listProjects } from "@/app/lib/mikeApi";
import { cn } from "@/app/lib/utils";
import type { AgentTask, AgentTaskStatus } from "@/app/types/agent";

type TaskFilter = "all" | "active" | "attention" | "review";

const FILTERS: Record<TaskFilter, AgentTaskStatus[]> = {
    all: [],
    active: ["queued", "running", "verifying"],
    attention: ["waiting_input", "paused", "failed"],
    review: ["completed"],
};

const STATUS_META: Record<
    AgentTaskStatus,
    { label: string; badge: string; icon: typeof Circle }
> = {
    queued: {
        label: "Ready",
        badge: "bg-gray-100 text-gray-700",
        icon: Circle,
    },
    running: {
        label: "Running",
        badge: "bg-blue-50 text-blue-800",
        icon: Loader2,
    },
    waiting_input: {
        label: "Input required",
        badge: "bg-amber-50 text-amber-900",
        icon: AlertCircle,
    },
    verifying: {
        label: "Verifying",
        badge: "bg-violet-50 text-violet-800",
        icon: Loader2,
    },
    paused: {
        label: "Paused",
        badge: "bg-gray-100 text-gray-700",
        icon: Clock3,
    },
    completed: {
        label: "Lawyer review",
        badge: "bg-emerald-50 text-emerald-800",
        icon: CheckCircle2,
    },
    failed: {
        label: "Failed",
        badge: "bg-red-50 text-red-800",
        icon: AlertCircle,
    },
};

function formatUpdatedAt(value: string) {
    return new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
    }).format(new Date(value));
}

function modelLabel(modelId: string) {
    return MODELS.find((model) => model.id === modelId)?.label ?? modelId;
}

function taskProgress(task: AgentTask) {
    const plan = task.current_plan ?? [];
    const completed = plan.filter((step) => step.status === "completed").length;
    return { completed, total: plan.length };
}

export function WorkTasksOverview() {
    const router = useRouter();
    const [search, setSearch] = useState("");
    return (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            <PageHeader
                actions={[
                    {
                        type: "search",
                        value: search,
                        onChange: setSearch,
                        placeholder: "Search work tasks…",
                    },
                    {
                        icon: <Plus className="h-4 w-4" />,
                        label: <span className="hidden sm:inline">Work task</span>,
                        title: "Create work task",
                        onClick: () => router.push("/assistant?mode=work"),
                    },
                ]}
            >
                <h1 className="font-serif text-2xl font-medium text-gray-900">
                    Work Tasks
                </h1>
            </PageHeader>
            <WorkTasksTable search={search} />
        </div>
    );
}

export function WorkTasksTable({
    matterId,
    search = "",
    showMatter = true,
}: {
    matterId?: string;
    search?: string;
    showMatter?: boolean;
}) {
    const router = useRouter();
    const [tasks, setTasks] = useState<AgentTask[]>([]);
    const [projects, setProjects] = useState<Project[]>([]);
    const [filter, setFilter] = useState<TaskFilter>("all");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void Promise.all([
            listAgentTasks(matterId),
            listProjects().catch(() => [] as Project[]),
        ])
            .then(([loadedTasks, loadedProjects]) => {
                if (cancelled) return;
                setTasks(loadedTasks);
                setProjects(loadedProjects);
            })
            .catch((loadError) => {
                if (cancelled) return;
                setTasks([]);
                setProjects([]);
                setError(
                    loadError instanceof Error
                        ? loadError.message
                        : "Work tasks could not be loaded.",
                );
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [matterId]);

    const projectNames = useMemo(
        () => new Map(projects.map((project) => [project.id, project.name])),
        [projects],
    );
    const counts = useMemo(
        () => ({
            active: tasks.filter((task) => FILTERS.active.includes(task.status))
                .length,
            attention: tasks.filter((task) =>
                FILTERS.attention.includes(task.status),
            ).length,
            review: tasks.filter((task) => FILTERS.review.includes(task.status))
                .length,
        }),
        [tasks],
    );
    const visibleTasks = useMemo(() => {
        const query = search.trim().toLocaleLowerCase();
        return tasks.filter((task) => {
            if (FILTERS[filter].length && !FILTERS[filter].includes(task.status)) {
                return false;
            }
            if (!query) return true;
            const matterName = projectNames.get(task.matter_id) ?? "";
            return `${task.goal} ${matterName} ${modelLabel(task.execution_model)}`
                .toLocaleLowerCase()
                .includes(query);
        });
    }, [filter, projectNames, search, tasks]);

    const filterItems = [
        { id: "all" as const, label: `All ${tasks.length}` },
        { id: "active" as const, label: `Active ${counts.active}` },
        {
            id: "attention" as const,
            label: `Needs attention ${counts.attention}`,
        },
        { id: "review" as const, label: `Lawyer review ${counts.review}` },
    ];

    return (
        <>
            <TableToolbar
                items={filterItems}
                active={filter}
                onChange={setFilter}
            />
            <TableScrollArea
                header={
                    <TableHeaderRow>
                        <TableStickyCell
                            header
                            widthClassName="w-[320px] sm:w-[350px] lg:w-[380px] shrink-0"
                        >
                            Goal
                        </TableStickyCell>
                        <TableHeaderCell className="w-[150px]">Status</TableHeaderCell>
                        {showMatter && (
                            <TableHeaderCell className="w-[200px]">Matter</TableHeaderCell>
                        )}
                        <TableHeaderCell className="w-[120px]">Progress</TableHeaderCell>
                        <TableHeaderCell className="hidden w-40 xl:flex">Model</TableHeaderCell>
                        <TableHeaderCell className="hidden w-32 2xl:flex">Updated</TableHeaderCell>
                        <TableHeaderCell className="w-8" />
                    </TableHeaderRow>
                }
            >
                {loading ? (
                    <TableBody>
                        {[1, 2, 3, 4].map((row) => (
                            <TableRow key={row} interactive={false}>
                                <TableStickyCell
                                    widthClassName="w-[320px] sm:w-[350px] lg:w-[380px] shrink-0"
                                    bgClassName="bg-transparent"
                                    hover={false}
                                >
                                    <SkeletonLine className="w-64" />
                                </TableStickyCell>
                                <TableCell className="w-[150px]">
                                    <SkeletonLine className="w-20" />
                                </TableCell>
                                {showMatter && (
                                    <TableCell className="w-[200px]">
                                        <SkeletonLine className="w-32" />
                                    </TableCell>
                                )}
                                <TableCell className="w-[120px]">
                                    <SkeletonLine className="w-20" />
                                </TableCell>
                                <TableCell className="hidden w-40 xl:block">
                                    <SkeletonLine className="w-24" />
                                </TableCell>
                                <TableCell className="hidden w-32 2xl:block">
                                    <SkeletonLine className="w-20" />
                                </TableCell>
                                <TableCell className="w-8" />
                            </TableRow>
                        ))}
                    </TableBody>
                ) : error ? (
                    <TableEmptyState>
                        <AlertCircle className="mb-4 h-7 w-7 text-red-600" />
                        <p className="text-sm font-semibold text-gray-900">
                            Work tasks unavailable
                        </p>
                        <p className="mt-1 max-w-[32ch] text-xs leading-5 text-red-700">
                            {error}
                        </p>
                    </TableEmptyState>
                ) : visibleTasks.length === 0 ? (
                    <TableEmptyState>
                        <TaskSkeuoIcon className="mb-4 h-8 w-8" />
                        <p className="font-serif text-xl font-medium text-gray-900">
                            {tasks.length === 0 ? "No work tasks yet" : "No matching tasks"}
                        </p>
                        <p className="mt-1 max-w-[34ch] text-xs leading-5 text-gray-500">
                            {tasks.length === 0
                                ? "Start in Assistant, choose Work, and attach documents from a Matter."
                                : "Change the status filter or search terms."}
                        </p>
                    </TableEmptyState>
                ) : (
                    <TableBody>
                        {visibleTasks.map((task) => {
                            const status = STATUS_META[task.status];
                            const StatusIcon = status.icon;
                            const progress = taskProgress(task);
                            const providerQueued =
                                task.status === "paused" &&
                                task.latest_checkpoint?.summary.startsWith(
                                    "Provider queue:",
                                );
                            const openTask = () =>
                                router.push(`/agent-tasks/${task.id}`);
                            return (
                                <TableRow
                                    key={task.id}
                                    role="link"
                                    tabIndex={0}
                                    aria-label={`Open work task: ${task.goal}`}
                                    onClick={openTask}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" || event.key === " ") {
                                            event.preventDefault();
                                            openTask();
                                        }
                                    }}
                                    className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600"
                                >
                                    <TableStickyCell
                                        widthClassName="w-[320px] sm:w-[350px] lg:w-[380px] shrink-0"
                                    >
                                        <TaskSkeuoIcon className="mr-2.5 h-4 w-4 shrink-0" />
                                        <span className="min-w-0 flex-1 truncate text-sm text-gray-800">
                                            {task.goal}
                                        </span>
                                    </TableStickyCell>
                                    <TableCell className="w-[150px]">
                                        <span
                                            className={cn(
                                                "inline-flex max-w-[145px] items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium",
                                                status.badge,
                                            )}
                                        >
                                            <StatusIcon
                                                className={cn(
                                                    "h-3 w-3 shrink-0",
                                                    ["running", "verifying"].includes(
                                                        task.status,
                                                    ) && "animate-spin",
                                                )}
                                                aria-hidden="true"
                                            />
                                            <span className="truncate">
                                                {providerQueued
                                                    ? "Provider queue"
                                                    : status.label}
                                            </span>
                                        </span>
                                    </TableCell>
                                    {showMatter && (
                                        <TableCell
                                            className="w-[200px]"
                                            title={projectNames.get(task.matter_id)}
                                        >
                                            {projectNames.get(task.matter_id) ?? "Matter unavailable"}
                                        </TableCell>
                                    )}
                                    <TableCell className="w-[120px]">
                                        <span
                                            className="inline-flex items-center gap-2"
                                            aria-label={`Progress: ${progress.completed} of ${progress.total} steps complete`}
                                        >
                                            <span
                                                className="h-1.5 w-16 overflow-hidden rounded-full bg-gray-200"
                                                role="progressbar"
                                                aria-valuemin={0}
                                                aria-valuemax={Math.max(progress.total, 1)}
                                                aria-valuenow={progress.completed}
                                            >
                                                <span
                                                    className={cn(
                                                        "block h-full rounded-full",
                                                        task.status === "failed"
                                                            ? "bg-red-500"
                                                            : task.status === "completed"
                                                              ? "bg-emerald-600"
                                                              : "bg-blue-600",
                                                    )}
                                                    style={{
                                                        width: `${progress.total ? (progress.completed / progress.total) * 100 : 0}%`,
                                                    }}
                                                />
                                            </span>
                                            <span className="text-xs text-gray-600">
                                                {progress.completed}/{progress.total}
                                            </span>
                                        </span>
                                    </TableCell>
                                    <TableCell
                                        className="hidden w-40 xl:block"
                                        title={modelLabel(task.execution_model)}
                                    >
                                        {modelLabel(task.execution_model)}
                                    </TableCell>
                                    <TableCell className="hidden w-32 2xl:block">
                                        {formatUpdatedAt(task.updated_at)}
                                    </TableCell>
                                    <TableCell className="flex w-8 justify-end">
                                        <ArrowRight className="h-3.5 w-3.5 text-gray-300 transition-colors group-hover:text-gray-600" />
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                )}
            </TableScrollArea>
        </>
    );
}
