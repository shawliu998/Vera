import Link from "next/link";
import { ArrowRight, Library } from "lucide-react";
import { AletheiaShell } from "@/aletheia/AletheiaShell";
import { templates } from "@/aletheia/mockData";
import { Badge } from "@/components/ui/badge";

export default function AletheiaTemplatesPage() {
    return (
        <AletheiaShell>
            <section className="flex min-h-full flex-col bg-white">
                <div className="flex items-center justify-between px-8 py-4">
                    <div>
                        <h1 className="font-serif text-2xl font-medium text-gray-900">
                            Workflow Templates
                        </h1>
                        <p className="mt-1 text-xs text-gray-400">
                            Reusable expert workflows with structured outputs and audit events.
                        </p>
                    </div>
                </div>

                <div className="flex h-10 items-center gap-5 border-b border-t border-gray-100 px-8 text-sm">
                    <span className="font-medium text-gray-900">All Templates</span>
                    <span className="ml-auto text-xs text-gray-400">
                        {templates.length} workflows
                    </span>
                </div>

                <div className="min-w-0 overflow-x-auto">
                    <div className="min-w-[860px]">
                        <div className="flex h-8 items-center border-b border-gray-200 pr-8 text-xs font-medium text-gray-500">
                            <div className="w-8 shrink-0" />
                            <div className="min-w-0 flex-1 pl-2 pr-4">Name</div>
                            <div className="w-40 shrink-0">Maturity</div>
                            <div className="w-72 shrink-0">Workflow</div>
                            <div className="w-8 shrink-0" />
                        </div>
                    {templates.map((template) => (
                        <Link
                            key={template.id}
                            href={
                                template.id === "legal_matter_review"
                                    ? "/aletheia/matters/matter-demo-legal-001"
                                    : `/aletheia/templates/${template.id}`
                            }
                                className="group flex h-16 items-center border-b border-gray-50 pr-8 transition-colors hover:bg-gray-50"
                        >
                                <div className="flex w-8 shrink-0 justify-center">
                                    <Library className="h-3.5 w-3.5 text-gray-300 group-hover:text-gray-500" />
                                </div>
                                <div className="min-w-0 flex-1 pl-2 pr-4">
                                    <p className="truncate text-sm text-gray-800">
                                        {template.name}
                                    </p>
                                    <p className="mt-0.5 truncate text-xs text-gray-400">
                                        {template.description}
                                    </p>
                                </div>
                                <div className="w-40 shrink-0">
                                    <Badge
                                        variant="outline"
                                        className="rounded-full border-gray-200 bg-white px-2 py-0 text-[11px] text-gray-600"
                                    >
                                        {template.maturity === "complete_demo"
                                            ? "local MVP"
                                            : "local pilot"}
                                    </Badge>
                                </div>
                                <div className="w-72 shrink-0 truncate text-sm text-gray-500">
                                    {template.workflow.slice(0, 4).join(" -> ")}
                                </div>
                                <ArrowRight className="h-4 w-8 shrink-0 text-gray-300 transition-colors group-hover:text-gray-600" />
                        </Link>
                    ))}
                    </div>
                </div>
            </section>
        </AletheiaShell>
    );
}
