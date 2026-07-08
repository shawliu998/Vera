"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    createAletheiaMatter,
    type AletheiaMatterTemplate,
    type AletheiaRiskLevel,
} from "@/app/lib/aletheiaApi";

const templates: { value: AletheiaMatterTemplate; label: string }[] = [
    { value: "legal_matter_review", label: "Legal Matter Review" },
    { value: "compliance_impact_review", label: "Compliance Impact Review" },
    { value: "deal_due_diligence", label: "Deal Due Diligence" },
];

const riskLevels: { value: AletheiaRiskLevel; label: string }[] = [
    { value: "high", label: "High" },
    { value: "medium", label: "Medium" },
    { value: "low", label: "Low" },
];

export function NewMatterButton({ initialOpen = false }: { initialOpen?: boolean }) {
    const router = useRouter();
    const [open, setOpen] = useState(initialOpen);
    const [title, setTitle] = useState("");
    const [objective, setObjective] = useState("");
    const [clientOrProject, setClientOrProject] = useState("");
    const [template, setTemplate] =
        useState<AletheiaMatterTemplate>("legal_matter_review");
    const [riskLevel, setRiskLevel] = useState<AletheiaRiskLevel>("high");
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);

    async function submit() {
        setError("");
        setSaving(true);
        try {
            const matter = await createAletheiaMatter({
                title,
                objective,
                template,
                riskLevel,
                clientOrProject,
                status: "draft",
            });
            setOpen(false);
            router.push(`/aletheia/matters/${matter.id}`);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Matter creation failed");
        } finally {
            setSaving(false);
        }
    }

    return (
        <>
            <Button
                onClick={() => setOpen(true)}
                className="rounded-full bg-gray-900 px-3 py-1 text-xs font-medium text-white shadow-md hover:bg-gray-700"
            >
                <Plus className="h-4 w-4" />
                New Matter
            </Button>

            {open && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
                    <div className="flex max-h-[86dvh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl">
                        <div className="flex items-center justify-between gap-3">
                            <div className="px-6 pt-5">
                                <div className="text-xs text-gray-400">
                                    Matters
                                </div>
                                <h2 className="mt-1 font-serif text-2xl font-medium text-gray-900">
                                    New Matter
                                </h2>
                                <p className="mt-1 text-xs leading-5 text-gray-500">
                                    Create an auditable workspace for a professional review.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setOpen(false)}
                                className="mr-4 mt-4 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                                aria-label="Close"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>

                        <div className="mt-5 grid gap-4 overflow-y-auto px-6">
                            <label className="grid gap-1 text-sm font-medium">
                                Title
                                <input
                                    value={title}
                                    onChange={(event) => setTitle(event.target.value)}
                                    className="h-10 rounded-lg border border-gray-200 px-3 text-sm font-normal outline-none transition-colors focus:border-gray-400"
                                />
                            </label>

                            <label className="grid gap-1 text-sm font-medium">
                                Template
                                <select
                                    value={template}
                                    onChange={(event) =>
                                        setTemplate(event.target.value as AletheiaMatterTemplate)
                                    }
                                    className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm font-normal outline-none transition-colors focus:border-gray-400"
                                >
                                    {templates.map((item) => (
                                        <option key={item.value} value={item.value}>
                                            {item.label}
                                        </option>
                                    ))}
                                </select>
                            </label>

                            <label className="grid gap-1 text-sm font-medium">
                                Objective
                                <textarea
                                    value={objective}
                                    onChange={(event) => setObjective(event.target.value)}
                                    className="min-h-24 rounded-lg border border-gray-200 px-3 py-2 text-sm font-normal outline-none transition-colors focus:border-gray-400"
                                />
                            </label>

                            <div className="grid gap-4 md:grid-cols-2">
                                <label className="grid gap-1 text-sm font-medium">
                                    Workspace
                                    <input
                                        value={clientOrProject}
                                        onChange={(event) =>
                                            setClientOrProject(event.target.value)
                                        }
                                        className="h-10 rounded-lg border border-gray-200 px-3 text-sm font-normal outline-none transition-colors focus:border-gray-400"
                                    />
                                </label>
                                <label className="grid gap-1 text-sm font-medium">
                                    Risk
                                    <select
                                        value={riskLevel}
                                        onChange={(event) =>
                                            setRiskLevel(event.target.value as AletheiaRiskLevel)
                                        }
                                        className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm font-normal outline-none transition-colors focus:border-gray-400"
                                    >
                                        {riskLevels.map((item) => (
                                            <option key={item.value} value={item.value}>
                                                {item.label}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                            </div>
                        </div>

                        {error && (
                            <p className="mx-6 mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                                {error}
                            </p>
                        )}

                        <div className="mt-5 flex justify-end gap-2 border-t border-gray-100 px-6 py-4">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => setOpen(false)}
                                className="rounded-lg border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-100"
                            >
                                Cancel
                            </Button>
                            <Button
                                type="button"
                                onClick={submit}
                                disabled={saving || !title.trim() || !objective.trim()}
                                className="rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40"
                            >
                                {saving ? "Creating..." : "Create Matter"}
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
