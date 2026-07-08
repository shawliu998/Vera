"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Bot, Database, FileCheck2, FileSearch, History } from "lucide-react";
import { AletheiaShell } from "./AletheiaShell";
import {
    createAletheiaAgentRun,
    createAletheiaWorkProduct,
    getAletheiaMatter,
    type AletheiaMatterDetail,
    type AletheiaWorkProductKind,
} from "@/app/lib/aletheiaApi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function titleize(value: string) {
    return value.replaceAll("_", " ");
}

function buildAuditPack(detail: AletheiaMatterDetail): Record<string, unknown> {
    return {
        schemaVersion: "aletheia-audit-pack-v0",
        exportedAt: new Date().toISOString(),
        matter: detail.matter,
        documents: detail.documents,
        workProducts: detail.workProducts,
        evidence: detail.evidence,
        reviews: detail.reviews,
        auditEvents: detail.auditEvents,
    };
}

function buildFeedbackDataset(detail: AletheiaMatterDetail): Record<string, unknown> {
    return {
        schemaVersion: "aletheia-feedback-eval-v0",
        exportedAt: new Date().toISOString(),
        matterId: detail.matter.id,
        matterTitle: detail.matter.title,
        objective: detail.matter.objective,
        records: detail.reviews.map((review) => ({
            id: review.id,
            createdAt: review.created_at,
            reviewer: review.reviewer_name ?? review.reviewer_user_id,
            tag: review.tag,
            comment: review.comment,
            targetType: review.target_type,
            targetId: review.target_id,
            evidence: detail.evidence.filter(
                (item) =>
                    item.id === review.evidence_item_id ||
                    item.claim_id === review.target_id,
            ),
        })),
    };
}

function stringArray(value: unknown) {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
}

export function RemoteMatterPage({ matterId }: { matterId: string }) {
    const [detail, setDetail] = useState<AletheiaMatterDetail | null>(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const [savingKind, setSavingKind] = useState<AletheiaWorkProductKind | null>(null);
    const [creatingRun, setCreatingRun] = useState(false);
    const [saveMessage, setSaveMessage] = useState("");

    useEffect(() => {
        let cancelled = false;
        async function load() {
            setLoading(true);
            setError("");
            try {
                const data = await getAletheiaMatter(matterId);
                if (!cancelled) setDetail(data);
            } catch (err) {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : "Matter load failed");
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        void load();
        return () => {
            cancelled = true;
        };
    }, [matterId]);

    async function saveWorkProduct(kind: "audit_pack" | "feedback_export") {
        if (!detail) return;
        setSavingKind(kind);
        setSaveMessage("");
        setError("");

        try {
            await createAletheiaWorkProduct(matterId, {
                kind,
                title:
                    kind === "audit_pack"
                        ? `${detail.matter.title} Audit Pack`
                        : `${detail.matter.title} Feedback Eval Dataset`,
                schemaVersion:
                    kind === "audit_pack"
                        ? "aletheia-audit-pack-v0"
                        : "aletheia-feedback-eval-v0",
                content:
                    kind === "audit_pack"
                        ? buildAuditPack(detail)
                        : buildFeedbackDataset(detail),
                generatedBy: "human",
            });
            const refreshed = await getAletheiaMatter(matterId);
            setDetail(refreshed);
            setSaveMessage(
                kind === "audit_pack"
                    ? "Audit pack saved to work products."
                    : "Feedback dataset saved to work products.",
            );
        } catch (err) {
            setError(err instanceof Error ? err.message : "Work product save failed");
        } finally {
            setSavingKind(null);
        }
    }

    async function createRuntimeRun() {
        if (!detail) return;
        setCreatingRun(true);
        setSaveMessage("");
        setError("");

        try {
            await createAletheiaAgentRun(matterId, {
                workflow: detail.matter.template,
                goal: detail.matter.objective,
                status: "queued",
                metadata: {
                    source: "remote_matter_page",
                    runtimeVersion: "aletheia-agent-runtime-v0",
                },
            });
            const refreshed = await getAletheiaMatter(matterId);
            setDetail(refreshed);
            setSaveMessage("Agent run queued.");
        } catch (err) {
            setError(err instanceof Error ? err.message : "Agent run creation failed");
        } finally {
            setCreatingRun(false);
        }
    }

    return (
        <AletheiaShell>
            <section className="mx-auto max-w-7xl px-5 py-6">
                <Link
                    href="/aletheia"
                    className="inline-flex items-center gap-2 text-sm font-medium text-[#6b7280] hover:text-[#111827]"
                >
                    <ArrowLeft className="h-4 w-4" />
                    Matters
                </Link>

                {loading && (
                    <div className="mt-5 rounded-lg border border-[#e5e7eb] bg-white p-6">
                        <p className="text-sm text-[#6b7280]">Loading matter...</p>
                    </div>
                )}

                {error && (
                    <div className="mt-5 rounded-lg border border-red-200 bg-red-50 p-6 text-red-700">
                        <p className="font-semibold">Matter could not be loaded</p>
                        <p className="mt-2 text-sm">{error}</p>
                    </div>
                )}

                {detail && (
                    <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_360px]">
                        <section className="space-y-4">
                            <section className="rounded-lg border border-[#e5e7eb] bg-white p-5">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div>
                                        <h1 className="text-3xl font-semibold tracking-tight">
                                            {detail.matter.title}
                                        </h1>
                                        <p className="mt-3 max-w-3xl text-sm leading-6 text-[#6b7280]">
                                            {detail.matter.objective}
                                        </p>
                                    </div>
                                    <Badge variant="outline" className="rounded-md border-[#e5e7eb] text-[#374151]">
                                        {titleize(detail.matter.status)}
                                    </Badge>
                                </div>

                                <div className="mt-5 grid gap-4 md:grid-cols-4">
                                    {[
                                        {
                                            icon: Database,
                                            label: "Documents",
                                            value: detail.documents.length,
                                        },
                                        {
                                            icon: FileSearch,
                                            label: "Evidence",
                                            value: detail.evidence.length,
                                        },
                                        {
                                            icon: History,
                                            label: "Audit events",
                                            value: detail.auditEvents.length,
                                        },
                                        {
                                            icon: Bot,
                                            label: "Agent runs",
                                            value: detail.agentRuns?.length ?? 0,
                                        },
                                    ].map((item) => (
                                        <div key={item.label} className="rounded-md border border-[#e5e7eb] p-4">
                                            <item.icon className="h-5 w-5 text-[#111827]" />
                                            <p className="mt-3 text-2xl font-semibold">{item.value}</p>
                                            <p className="mt-1 text-sm text-[#6b7280]">{item.label}</p>
                                        </div>
                                    ))}
                                </div>
                            </section>

                            {(() => {
                                const plan = detail.workProducts.find(
                                    (item) => item.kind === "agent_plan",
                                );
                                if (!plan) return null;
                                const requiredDocuments = stringArray(
                                    plan.content.requiredDocuments,
                                );
                                const missingMaterials = stringArray(
                                    plan.content.missingMaterials,
                                );
                                const steps = stringArray(plan.content.steps);
                                return (
                                    <section className="rounded-lg border border-[#e5e7eb] bg-white p-5">
                                        <div className="flex flex-wrap items-center justify-between gap-3">
                                            <div>
                                                <p className="text-xs font-semibold uppercase text-[#9ca3af]">
                                                    Deterministic Scaffold
                                                </p>
                                                <h2 className="mt-1 text-lg font-semibold">
                                                    {plan.title}
                                                </h2>
                                            </div>
                                            <Badge variant="outline" className="rounded-md border-[#e5e7eb] text-[#374151]">
                                                {plan.schema_version}
                                            </Badge>
                                        </div>
                                        <div className="mt-4 grid gap-3 md:grid-cols-3">
                                            <div className="rounded-md border border-[#e5e7eb] p-3">
                                                <p className="text-xs font-semibold text-[#9ca3af]">
                                                    Required Documents
                                                </p>
                                                <ul className="mt-2 space-y-1 text-sm text-[#374151]">
                                                    {requiredDocuments.map((item) => (
                                                        <li key={item}>- {item}</li>
                                                    ))}
                                                </ul>
                                            </div>
                                            <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                                                <p className="text-xs font-semibold text-amber-700">
                                                    Missing Materials
                                                </p>
                                                <ul className="mt-2 space-y-1 text-sm text-amber-900">
                                                    {missingMaterials.map((item) => (
                                                        <li key={item}>- {item}</li>
                                                    ))}
                                                </ul>
                                            </div>
                                            <div className="rounded-md border border-[#e5e7eb] p-3">
                                                <p className="text-xs font-semibold text-[#9ca3af]">
                                                    Workflow Steps
                                                </p>
                                                <ul className="mt-2 space-y-1 text-sm text-[#374151]">
                                                    {steps.map((item) => (
                                                        <li key={item}>- {item}</li>
                                                    ))}
                                                </ul>
                                            </div>
                                        </div>
                                    </section>
                                );
                            })()}
                        </section>

                        <aside className="space-y-4">
                            <section className="rounded-lg border border-[#e5e7eb] bg-white p-4">
                                <div className="flex items-center gap-2">
                                    <FileCheck2 className="h-4 w-4 text-[#111827]" />
                                    <h2 className="font-semibold">Persistent Artifacts</h2>
                                </div>
                                <div className="mt-3 grid gap-2">
                                    <Button
                                        variant="outline"
                                        disabled={savingKind !== null}
                                        onClick={() => void saveWorkProduct("audit_pack")}
                                        className="justify-start border-[#e5e7eb] text-[#374151] hover:bg-[#f9fafb]"
                                    >
                                        Save Audit Pack
                                    </Button>
                                    <Button
                                        variant="outline"
                                        disabled={savingKind !== null}
                                        onClick={() => void saveWorkProduct("feedback_export")}
                                        className="justify-start border-[#e5e7eb] text-[#374151] hover:bg-[#f9fafb]"
                                    >
                                        Save Feedback Dataset
                                    </Button>
                                    <Button
                                        variant="outline"
                                        disabled={creatingRun || savingKind !== null}
                                        onClick={() => void createRuntimeRun()}
                                        className="justify-start border-[#b7c9c2] text-[#315a51] hover:bg-[#eef6f2]"
                                    >
                                        Queue Agent Run
                                    </Button>
                                </div>
                                {creatingRun && (
                                    <p className="mt-3 text-sm text-[#536962]">
                                        Creating agent run...
                                    </p>
                                )}
                                {savingKind && (
                                    <p className="mt-3 text-sm text-[#6b7280]">
                                        Saving {titleize(savingKind)}...
                                    </p>
                                )}
                                {saveMessage && (
                                    <p className="mt-3 text-sm text-emerald-700">
                                        {saveMessage}
                                    </p>
                                )}
                            </section>

                            <section className="rounded-lg border border-[#e5e7eb] bg-white p-4">
                                <h2 className="font-semibold">Work Products</h2>
                                <div className="mt-3 space-y-3">
                                    {detail.workProducts.length === 0 ? (
                                        <p className="text-sm text-[#6b7280]">
                                            No work products generated yet.
                                        </p>
                                    ) : (
                                        detail.workProducts.map((item) => (
                                            <div
                                                key={item.id}
                                                className="rounded-md border border-[#e5e7eb] p-3"
                                            >
                                                <div className="flex items-center justify-between gap-2">
                                                    <p className="text-sm font-medium">{titleize(item.kind)}</p>
                                                    <Badge
                                                        variant="outline"
                                                        className="rounded-md border-[#e5e7eb] text-[#374151]"
                                                    >
                                                        {titleize(item.status)}
                                                    </Badge>
                                                </div>
                                                <p className="mt-2 text-sm text-[#6b7280]">{item.title}</p>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </section>
                        </aside>
                    </div>
                )}
            </section>
        </AletheiaShell>
    );
}
