"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Scale } from "lucide-react";
import { templates } from "./mockData";
import { getMatterSummaries, getReviewQueue } from "./workflow";
import { NewMatterButton } from "./NewMatterButton";
import {
    listAletheiaMatters,
    type AletheiaMatterOverview,
} from "@/app/lib/aletheiaApi";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type MatterQueueItem = ReturnType<typeof getMatterSummaries>[number] & {
    href: string;
    source: "api" | "demo";
};

function riskClass(risk?: string | null) {
    if (risk === "high") return "border-red-100 bg-red-50 text-red-600";
    if (risk === "medium") return "border-amber-100 bg-amber-50 text-amber-700";
    return "border-gray-200 bg-gray-50 text-gray-600";
}

function statusClass(status: string) {
    if (status === "needs_review") return "border-amber-100 bg-amber-50 text-amber-700";
    if (status === "completed") return "border-gray-200 bg-gray-50 text-gray-600";
    return "border-gray-200 bg-white text-gray-600";
}

function titleize(value: string) {
    return value.replaceAll("_", " ");
}

function templateName(templateId: string) {
    return templates.find((template) => template.id === templateId)?.name ?? templateId;
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
        href: `/aletheia/matters/${matter.id}`,
        source: "api",
    };
}

export function AletheiaMatterDashboard({
    initialNewMatterOpen,
}: {
    initialNewMatterOpen: boolean;
}) {
    const demoMatters = useMemo<MatterQueueItem[]>(
        () =>
            getMatterSummaries().map((matter) => ({
                ...matter,
                href:
                    matter.template === "legal_matter_review"
                        ? "/aletheia/matters/matter-demo-legal-001"
                        : `/aletheia/templates/${matter.template}`,
                source: "demo" as const,
            })),
        [],
    );
    const reviewQueue = useMemo(() => getReviewQueue(), []);
    const [apiMatters, setApiMatters] = useState<MatterQueueItem[]>([]);
    const [apiState, setApiState] = useState<"checking" | "connected" | "fallback">(
        "checking",
    );

    useEffect(() => {
        let cancelled = false;
        async function loadMatters() {
            try {
                const records = await listAletheiaMatters();
                if (cancelled) return;
                setApiMatters(records.map(remoteToQueueItem));
                setApiState("connected");
            } catch {
                if (!cancelled) setApiState("fallback");
            }
        }
        void loadMatters();
        return () => {
            cancelled = true;
        };
    }, []);

    const matters = useMemo(() => {
        const remoteIds = new Set(apiMatters.map((matter) => matter.id));
        return [
            ...apiMatters,
            ...demoMatters.filter((matter) => !remoteIds.has(matter.id)),
        ];
    }, [apiMatters, demoMatters]);

    const totalEvidence = matters.reduce((sum, matter) => sum + matter.evidenceCount, 0);
    const totalReviews = matters.reduce((sum, matter) => sum + matter.reviewCount, 0);

    return (
        <section className="flex min-h-full flex-col bg-white">
            <div className="flex items-center justify-between px-8 py-4">
                <div>
                    <h1 className="font-serif text-2xl font-medium text-gray-900">
                        Matters
                    </h1>
                    <p className="mt-1 text-xs text-gray-400">
                        {apiState === "connected"
                            ? "Database matters appear above demo matters."
                            : apiState === "checking"
                              ? "Checking API..."
                              : "Demo fallback mode"}
                    </p>
                </div>
                <NewMatterButton initialOpen={initialNewMatterOpen} />
            </div>

            <div className="flex h-10 items-center gap-5 border-b border-t border-gray-100 px-8 text-sm">
                <span className="font-medium text-gray-900">All Matters</span>
                <Link
                    href="/aletheia/reviews"
                    className="text-gray-500 transition-colors hover:text-gray-900"
                >
                    Review Queue
                </Link>
                <Link
                    href="/aletheia/evidence"
                    className="text-gray-500 transition-colors hover:text-gray-900"
                >
                    Evidence
                </Link>
                <div className="ml-auto hidden items-center gap-6 text-xs text-gray-400 md:flex">
                    <span>{matters.length} matters</span>
                    <span>{totalEvidence} evidence</span>
                    <span>{totalReviews} reviews</span>
                </div>
            </div>

            <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_340px]">
                <section className="min-w-0 overflow-x-auto">
                    <div className="min-w-0 md:min-w-[900px]">
                        <div className="flex h-8 items-center border-b border-gray-200 pr-8 text-xs font-medium text-gray-500">
                            <div className="w-8 shrink-0" />
                            <div className="flex-1 min-w-0 pl-2 pr-4">Name</div>
                            <div className="hidden w-52 shrink-0 md:block">Template</div>
                            <div className="hidden w-24 shrink-0 md:block">Docs</div>
                            <div className="hidden w-24 shrink-0 md:block">Evidence</div>
                            <div className="hidden w-28 shrink-0 md:block">Status</div>
                            <div className="w-8 shrink-0" />
                        </div>
                        <div>
                            {matters.map((matter) => (
                                <Link
                                    key={`${matter.source}-${matter.id}`}
                                    href={matter.href}
                                    className="group flex h-14 items-center border-b border-gray-50 pr-8 transition-colors hover:bg-gray-50"
                                >
                                    <div className="flex w-8 shrink-0 justify-center">
                                        <Scale className="h-3.5 w-3.5 text-gray-300 group-hover:text-gray-500" />
                                    </div>
                                    <div className="min-w-0 flex-1 pl-2 pr-4">
                                        <div className="flex min-w-0 items-center gap-2">
                                            <span className="truncate text-sm text-gray-800">
                                                {matter.title}
                                            </span>
                                            <Badge
                                                variant="outline"
                                                className={cn("rounded-full px-2 py-0 text-[11px]", riskClass(matter.riskLevel))}
                                            >
                                                {matter.riskLevel ?? "low"}
                                            </Badge>
                                            {matter.source === "api" && (
                                                <span className="text-[11px] text-gray-300">
                                                    database
                                                </span>
                                            )}
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
                                        <Badge
                                            variant="outline"
                                            className={cn("rounded-full px-2 py-0 text-[11px]", statusClass(matter.status))}
                                        >
                                            {titleize(matter.status)}
                                        </Badge>
                                    </div>
                                    <ArrowRight className="h-4 w-8 shrink-0 text-gray-300 transition-colors group-hover:text-gray-600" />
                                </Link>
                            ))}
                        </div>
                    </div>
                </section>

                <aside className="border-l border-gray-100 px-5 py-5">
                    <div className="flex items-center justify-between">
                        <h2 className="text-sm font-medium text-gray-900">Review Queue</h2>
                        <Link href="/aletheia/reviews" className="text-xs text-gray-400 hover:text-gray-900">
                            View all
                        </Link>
                    </div>
                    <div className="mt-4 space-y-4">
                        {reviewQueue.slice(0, 5).map((item) => (
                            <Link
                                key={item.id}
                                href="/aletheia/matters/matter-demo-legal-001"
                                className="block border-b border-gray-100 pb-4 last:border-b-0"
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-xs text-gray-400">
                                        {item.matterTitle}
                                    </span>
                                    <Badge
                                        variant="outline"
                                        className={cn("rounded-full px-2 py-0 text-[11px]", riskClass(item.riskLevel))}
                                    >
                                        {item.riskLevel}
                                    </Badge>
                                </div>
                                <p className="mt-2 text-sm font-medium leading-5 text-gray-800">
                                    {item.title}
                                </p>
                                <p className="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">
                                    {item.comment}
                                </p>
                            </Link>
                        ))}
                    </div>
                </aside>
            </div>
        </section>
    );
}
