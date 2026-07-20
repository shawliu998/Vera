"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
    AlertCircle,
    ArrowUpRight,
    Check,
    CheckCircle2,
    ChevronRight,
    Circle,
    Clock3,
    FileText,
    Grid2X2,
    Loader2,
    Pause,
    Play,
    ShieldCheck,
} from "lucide-react";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import {
    advanceMockAgentTask,
    getMockAgentTask,
    pauseMockAgentTask,
    resumeMockAgentTask,
} from "@/app/lib/agentMockClient";
import { cn } from "@/app/lib/utils";
import type {
    AgentArtifactType,
    AgentStepStatus,
    AgentTaskSnapshot,
    AgentTaskStatus,
} from "@/app/types/agent";

const STATUS_LABELS: Record<AgentTaskStatus, string> = {
    queued: "Ready",
    running: "Running",
    waiting_input: "Waiting for input",
    verifying: "Verifying",
    paused: "Paused",
    completed: "Ready for lawyer review",
    failed: "Failed",
};

const STATUS_STYLES: Record<AgentTaskStatus, string> = {
    queued: "border-gray-200 bg-white/70 text-gray-600",
    running: "border-blue-200 bg-blue-50/80 text-blue-700",
    waiting_input: "border-amber-200 bg-amber-50/80 text-amber-800",
    verifying: "border-violet-200 bg-violet-50/80 text-violet-700",
    paused: "border-gray-200 bg-gray-100/80 text-gray-700",
    completed: "border-emerald-200 bg-emerald-50/80 text-emerald-700",
    failed: "border-red-200 bg-red-50/80 text-red-700",
};

const STEP_ICONS: Record<AgentStepStatus, typeof Circle> = {
    pending: Circle,
    running: Loader2,
    completed: Check,
    blocked: AlertCircle,
    skipped: Circle,
};

const ARTIFACT_META: Record<
    AgentArtifactType,
    { label: string; icon: typeof FileText; badge: string; badgeClass: string }
> = {
    document: {
        label: "Source document",
        icon: FileText,
        badge: "SOURCE",
        badgeClass: "bg-gray-100 text-gray-600",
    },
    tabular_review: {
        label: "Contract risk matrix",
        icon: Grid2X2,
        badge: "FACTS + REVIEW",
        badgeClass: "bg-blue-50 text-blue-700",
    },
    draft: {
        label: "Review memo draft",
        icon: FileText,
        badge: "AI DRAFT",
        badgeClass: "bg-violet-50 text-violet-700",
    },
    chat: {
        label: "Assistant record",
        icon: FileText,
        badge: "WORKING RECORD",
        badgeClass: "bg-gray-100 text-gray-600",
    },
    workflow_run: {
        label: "Workflow run",
        icon: Grid2X2,
        badge: "WORKFLOW",
        badgeClass: "bg-blue-50 text-blue-700",
    },
    citation_snapshot: {
        label: "Citation snapshot",
        icon: ShieldCheck,
        badge: "EVIDENCE",
        badgeClass: "bg-emerald-50 text-emerald-700",
    },
};

export function AgentTaskWorkspace({ taskId }: { taskId: string }) {
    const router = useRouter();
    const [snapshot, setSnapshot] = useState<AgentTaskSnapshot | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [autoRun, setAutoRun] = useState(false);

    useEffect(() => {
        void getMockAgentTask(taskId).then((value) => {
            setSnapshot(value);
            setLoaded(true);
        });
    }, [taskId]);

    useEffect(() => {
        if (!autoRun || !snapshot) return;
        if (["completed", "failed", "paused", "waiting_input"].includes(snapshot.task.status)) {
            setAutoRun(false);
            return;
        }
        const timer = window.setTimeout(async () => {
            const next = await advanceMockAgentTask(taskId);
            setSnapshot({ ...next });
        }, snapshot.task.status === "verifying" ? 1250 : 900);
        return () => window.clearTimeout(timer);
    }, [autoRun, snapshot, taskId]);

    const completedSteps = useMemo(
        () =>
            snapshot?.task.current_plan.filter((step) => step.status === "completed")
                .length ?? 0,
        [snapshot],
    );

    async function runTask() {
        if (!snapshot) return;
        if (snapshot.task.status === "paused") {
            setSnapshot(await resumeMockAgentTask(taskId));
        }
        setAutoRun(true);
    }

    async function pauseTask() {
        setAutoRun(false);
        setSnapshot(await pauseMockAgentTask(taskId));
    }

    async function runNextStep() {
        if (!snapshot) return;
        const next = await advanceMockAgentTask(taskId);
        setSnapshot({ ...next });
    }

    if (!loaded) {
        return (
            <div className="flex h-full items-center justify-center text-sm text-gray-500">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading work task…
            </div>
        );
    }

    if (!snapshot) {
        return (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                <h1 className="font-serif text-2xl text-gray-900">Task not found</h1>
                <p className="mt-2 text-sm text-gray-500">This local mock task is no longer available.</p>
                <button
                    type="button"
                    onClick={() => router.push("/assistant")}
                    className="mt-5 rounded-full bg-gray-950 px-4 py-2 text-sm font-medium text-white"
                >
                    Return to Assistant
                </button>
            </div>
        );
    }

    const { task, artifacts } = snapshot;
    const terminal = task.status === "completed" || task.status === "failed";

    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <PageHeader
                shrink
                breadcrumbs={[
                    { label: "Work Tasks", onClick: () => router.push("/assistant") },
                    { label: "Project Cedar", cursor: "text" },
                ]}
                actions={[
                    {
                        type: "custom",
                        render: (
                            <span
                                className={cn(
                                    "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium",
                                    STATUS_STYLES[task.status],
                                )}
                            >
                                {task.status === "running" || task.status === "verifying" ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                ) : task.status === "completed" ? (
                                    <CheckCircle2 className="h-3 w-3" />
                                ) : (
                                    <Clock3 className="h-3 w-3" />
                                )}
                                {STATUS_LABELS[task.status]}
                            </span>
                        ),
                    },
                    !terminal && task.status !== "paused"
                        ? {
                              icon: <Pause className="h-3.5 w-3.5" />,
                              label: "Pause",
                              onClick: pauseTask,
                          }
                        : !terminal
                          ? {
                                icon: <Play className="h-3.5 w-3.5" />,
                                label: "Resume",
                                onClick: runTask,
                            }
                          : null,
                ]}
            />

            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 md:px-6 md:pb-6">
                <div className="mx-auto max-w-[1420px]">
                    <section className="mb-4 rounded-[20px] border border-white/75 bg-white/55 px-5 py-4 shadow-[0_8px_26px_rgba(15,23,42,0.055),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-2xl md:px-6">
                        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                            <div className="min-w-0">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-400">
                                    Matter · Project Cedar
                                </p>
                                <h1 className="mt-1 max-w-4xl text-pretty font-serif text-[26px] leading-8 text-gray-950 md:text-[30px] md:leading-9">
                                    {task.goal}
                                </h1>
                                <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-gray-500">
                                    <span className="inline-flex items-center gap-1.5">
                                        <FileTypeIcon fileType="docx" className="h-3.5 w-3.5" />
                                        synthetic-software-license-review.docx
                                    </span>
                                    <span>Current version · v2</span>
                                    <span>{completedSteps} of {task.current_plan.length} steps complete</span>
                                </div>
                            </div>
                            <div className="flex shrink-0 gap-2">
                                {!terminal && (
                                    <button
                                        type="button"
                                        onClick={runNextStep}
                                        disabled={autoRun || task.status === "paused"}
                                        className="h-9 rounded-full border border-white/80 bg-white/70 px-3.5 text-xs font-medium text-gray-700 shadow-[0_4px_12px_rgba(15,23,42,0.06)] transition-colors hover:bg-white disabled:cursor-default disabled:opacity-40"
                                    >
                                        Run next step
                                    </button>
                                )}
                                {!terminal && task.status !== "paused" && (
                                    <button
                                        type="button"
                                        onClick={runTask}
                                        disabled={autoRun}
                                        className="inline-flex h-9 items-center gap-1.5 rounded-full bg-gray-950 px-4 text-xs font-medium text-white shadow-[0_6px_16px_rgba(15,23,42,0.16)] transition-all hover:bg-black active:scale-[0.98] disabled:cursor-default disabled:opacity-45"
                                    >
                                        {autoRun ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                                        {autoRun ? "Running" : "Run task"}
                                    </button>
                                )}
                            </div>
                        </div>
                    </section>

                    <div className="grid min-h-0 gap-4 xl:grid-cols-[250px_minmax(0,1fr)_300px]">
                        <PlanPanel snapshot={snapshot} />
                        <ExecutionPanel snapshot={snapshot} />
                        <EvidencePanel snapshot={snapshot} />
                    </div>
                </div>
            </div>
        </div>
    );
}

function Panel({
    title,
    eyebrow,
    children,
    className,
}: {
    title: string;
    eyebrow?: string;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <section
            className={cn(
                "overflow-hidden rounded-[18px] border border-white/75 bg-white/55 shadow-[0_8px_28px_rgba(15,23,42,0.05),inset_0_1px_0_rgba(255,255,255,0.92)] backdrop-blur-2xl",
                className,
            )}
        >
            <header className="border-b border-gray-900/[0.055] px-4 py-3.5">
                {eyebrow && <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400">{eyebrow}</p>}
                <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
            </header>
            {children}
        </section>
    );
}

function PlanPanel({ snapshot }: { snapshot: AgentTaskSnapshot }) {
    return (
        <Panel title="Plan" eyebrow="Work task" className="self-start">
            <ol className="px-3 py-3">
                {snapshot.task.current_plan.map((step, index) => {
                    const Icon = STEP_ICONS[step.status];
                    const active = step.status === "running";
                    return (
                        <li key={step.id} className="relative flex gap-3 pb-4 last:pb-1">
                            {index < snapshot.task.current_plan.length - 1 && (
                                <span className="absolute left-[11px] top-6 h-[calc(100%-12px)] w-px bg-gray-200" />
                            )}
                            <span
                                className={cn(
                                    "relative z-10 mt-0.5 flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-full border bg-white",
                                    step.status === "completed" && "border-emerald-200 bg-emerald-50 text-emerald-700",
                                    active && "border-blue-200 bg-blue-50 text-blue-700",
                                    step.status === "pending" && "border-gray-200 text-gray-300",
                                    step.status === "blocked" && "border-red-200 bg-red-50 text-red-700",
                                )}
                            >
                                <Icon className={cn("h-3 w-3", active && "animate-spin")} />
                            </span>
                            <div className="min-w-0 pt-0.5">
                                <p className={cn("text-xs font-medium leading-5", active ? "text-gray-950" : "text-gray-700")}>{step.title}</p>
                                <p className="mt-0.5 text-[11px] leading-4 text-gray-400">
                                    {step.status === "completed" ? "Completed" : step.status === "running" ? `Attempt ${step.attempt}` : "Pending"}
                                </p>
                            </div>
                        </li>
                    );
                })}
            </ol>
        </Panel>
    );
}

function ExecutionPanel({ snapshot }: { snapshot: AgentTaskSnapshot }) {
    const latest = [...snapshot.task.current_plan].reverse().find((step) => step.status === "completed");
    const current = snapshot.task.current_plan.find((step) => step.status === "running");
    return (
        <Panel title="Execution" eyebrow="Current activity" className="min-w-0">
            <div className="p-4 md:p-5">
                {current ? (
                    <div className="rounded-2xl border border-blue-100 bg-blue-50/45 p-4">
                        <div className="flex items-start gap-3">
                            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-blue-700 shadow-sm">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            </span>
                            <div className="min-w-0">
                                <p className="text-xs font-semibold text-blue-800">In progress</p>
                                <h3 className="mt-1 text-sm font-semibold text-gray-950">{current.title}</h3>
                                <p className="mt-1 text-xs leading-5 text-gray-500">Expected: {current.expected_output}</p>
                            </div>
                        </div>
                    </div>
                ) : snapshot.task.status === "completed" ? (
                    <div className="rounded-2xl border border-emerald-100 bg-emerald-50/45 p-4">
                        <div className="flex items-start gap-3">
                            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
                            <div>
                                <p className="text-sm font-semibold text-gray-950">Work task complete</p>
                                <p className="mt-1 text-xs leading-5 text-gray-500">Required artifacts exist and the first-pass verifier found no unresolved execution gap.</p>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="rounded-2xl border border-gray-200 bg-white/55 p-4 text-sm text-gray-500">
                        Ready to run. The plan will execute as short, reviewable tool loops.
                    </div>
                )}

                <div className="mt-5">
                    <div className="flex items-center justify-between">
                        <h3 className="text-xs font-semibold text-gray-900">Activity</h3>
                        <span className="text-[11px] text-gray-400">Local task record</span>
                    </div>
                    <div className="mt-2 divide-y divide-gray-900/[0.055]">
                        {snapshot.task.current_plan
                            .filter((step) => step.status === "completed")
                            .map((step) => (
                                <div key={step.id} className="flex gap-3 py-3 first:pt-2">
                                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
                                        <Check className="h-3 w-3" />
                                    </span>
                                    <div className="min-w-0">
                                        <p className="text-xs font-medium text-gray-800">{step.title}</p>
                                        <p className="mt-1 text-xs leading-5 text-gray-500">{step.result_summary}</p>
                                    </div>
                                </div>
                            ))}
                        {!latest && <p className="py-5 text-xs text-gray-400">No steps have completed yet.</p>}
                    </div>
                </div>

                {snapshot.task.latest_checkpoint && (
                    <div className="mt-4 flex items-start gap-2 rounded-xl border border-gray-900/[0.06] bg-white/55 px-3 py-2.5">
                        <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
                        <div className="min-w-0">
                            <p className="text-[11px] font-medium text-gray-700">Checkpoint saved</p>
                            <p className="mt-0.5 text-[11px] leading-4 text-gray-400">{snapshot.task.latest_checkpoint.summary}</p>
                        </div>
                    </div>
                )}
            </div>
        </Panel>
    );
}

function EvidencePanel({ snapshot }: { snapshot: AgentTaskSnapshot }) {
    const verifyStarted = snapshot.task.status === "verifying" || snapshot.task.status === "completed";
    const verified = snapshot.task.status === "completed";
    const checks = [
        "Required deliverables exist",
        "Important facts have sources",
        "Facts, analysis, and advice are distinct",
        "No obvious omission or contradiction",
    ];
    return (
        <div className="grid gap-4 self-start md:grid-cols-2 xl:grid-cols-1">
            <Panel title="Artifacts" eyebrow={`${snapshot.artifacts.length} linked`}>
                <div className="divide-y divide-gray-900/[0.055] px-3 py-1.5">
                    {snapshot.artifacts.map((artifact) => {
                        const meta = ARTIFACT_META[artifact.artifact_type];
                        const Icon = meta.icon;
                        return (
                            <button
                                key={artifact.artifact_id}
                                type="button"
                                className="group flex w-full items-center gap-3 py-3 text-left"
                            >
                                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-gray-900/[0.06] bg-white/75 text-gray-500">
                                    <Icon className="h-3.5 w-3.5" />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-xs font-medium text-gray-800">{meta.label}</span>
                                    <span className={cn("mt-1 inline-flex rounded px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.08em]", meta.badgeClass)}>{meta.badge}</span>
                                </span>
                                <ArrowUpRight className="h-3.5 w-3.5 text-gray-300 transition-colors group-hover:text-gray-600" />
                            </button>
                        );
                    })}
                    {snapshot.artifacts.length === 0 && (
                        <p className="py-5 text-xs leading-5 text-gray-400">Artifacts appear here as steps complete.</p>
                    )}
                </div>
            </Panel>
            <Panel title="Verifier" eyebrow={verified ? "Checks passed" : verifyStarted ? "Checking" : "Pending"}>
                <ul className="px-3 py-2">
                    {checks.map((check) => (
                        <li key={check} className="flex items-start gap-2.5 py-2">
                            {verified ? (
                                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                            ) : verifyStarted ? (
                                <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-violet-600" />
                            ) : (
                                <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-300" />
                            )}
                            <span className="text-[11px] leading-4 text-gray-600">{check}</span>
                        </li>
                    ))}
                </ul>
                <div className="border-t border-gray-900/[0.055] px-3 py-3">
                    <div className="flex items-center justify-between text-[11px]">
                        <span className="text-gray-500">Lawyer review</span>
                        <span className="inline-flex items-center gap-1 font-medium text-amber-700">
                            Required <ChevronRight className="h-3 w-3" />
                        </span>
                    </div>
                </div>
            </Panel>
        </div>
    );
}
