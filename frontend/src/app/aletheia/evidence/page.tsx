import Link from "next/link";
import { ArrowRight, FileSearch } from "lucide-react";
import { AletheiaShell } from "@/aletheia/AletheiaShell";
import { getEvidenceQueue } from "@/aletheia/workflow";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function supportClass(status: string) {
    if (status === "supports") return "border-emerald-200 bg-emerald-50 text-emerald-700";
    if (status === "contradicts") return "border-red-200 bg-red-50 text-red-700";
    return "border-amber-200 bg-amber-50 text-amber-700";
}

export default function AletheiaEvidencePage() {
    const evidence = getEvidenceQueue();

    return (
        <AletheiaShell>
            <section className="flex min-h-full flex-col bg-white">
                <div className="px-8 py-4">
                    <h1 className="font-serif text-2xl font-medium text-gray-900">
                        Evidence Registry
                    </h1>
                    <p className="mt-1 text-xs text-gray-400">
                        Source-backed evidence with document location, support status, and target claim.
                    </p>
                </div>

                <div className="flex h-10 items-center gap-5 border-b border-t border-gray-100 px-8 text-sm">
                    <span className="font-medium text-gray-900">All Evidence</span>
                    <span className="ml-auto text-xs text-gray-400">
                        {evidence.length} records
                    </span>
                </div>

                <div className="min-w-0 overflow-x-auto">
                    <div className="min-w-[940px]">
                        <div className="flex h-8 items-center border-b border-gray-200 pr-8 text-xs font-medium text-gray-500">
                            <div className="w-8 shrink-0" />
                            <div className="w-64 shrink-0 pl-2 pr-4">Source</div>
                            <div className="min-w-0 flex-1 pr-4">Claim / Quote</div>
                            <div className="w-32 shrink-0">Status</div>
                            <div className="w-8 shrink-0" />
                    </div>
                        {evidence.map((item) => (
                            <Link
                                key={item.id}
                                href="/aletheia/matters/matter-demo-legal-001"
                                className="group flex min-h-16 items-center border-b border-gray-50 pr-8 transition-colors hover:bg-gray-50"
                            >
                                <div className="flex w-8 shrink-0 justify-center">
                                    <FileSearch className="h-3.5 w-3.5 text-gray-300 group-hover:text-gray-500" />
                                </div>
                                <div className="w-64 shrink-0 pl-2 pr-4">
                                    <p className="truncate text-sm text-gray-800">
                                        {item.documentName}
                                    </p>
                                    <p className="mt-0.5 truncate text-xs text-gray-400">
                                        p.{item.page} · {item.section}
                                    </p>
                                </div>
                                <div className="min-w-0 flex-1 pr-4 py-3">
                                    <p className="truncate text-sm text-gray-800">{item.issueTitle}</p>
                                    <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-gray-500">{item.quote}</p>
                                </div>
                                <div className="w-32 shrink-0">
                                    <Badge variant="outline" className={cn("rounded-full px-2 py-0 text-[11px]", supportClass(item.supportStatus))}>
                                        {item.supportStatus}
                                    </Badge>
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
