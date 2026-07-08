import Link from "next/link";
import { ArrowRight, ClipboardCheck } from "lucide-react";
import { AletheiaShell } from "@/aletheia/AletheiaShell";
import { getReviewQueue } from "@/aletheia/workflow";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function riskClass(risk?: string) {
    if (risk === "high") return "border-red-100 bg-red-50 text-red-600";
    if (risk === "medium") return "border-amber-100 bg-amber-50 text-amber-700";
    return "border-gray-200 bg-gray-50 text-gray-600";
}

function titleize(value: string) {
    return value.replaceAll("_", " ");
}

export default function AletheiaReviewsPage() {
    const reviews = getReviewQueue();

    return (
        <AletheiaShell>
            <section className="flex min-h-full flex-col bg-white">
                <div className="px-8 py-4">
                    <h1 className="font-serif text-2xl font-medium text-gray-900">
                        Human Review
                    </h1>
                    <p className="mt-1 text-xs text-gray-400">
                        Structured reviewer feedback for unsupported claims, missing facts, and badcases.
                    </p>
                </div>

                <div className="flex h-10 items-center gap-5 border-b border-t border-gray-100 px-8 text-sm">
                    <span className="font-medium text-gray-900">Review Queue</span>
                    <span className="ml-auto text-xs text-gray-400">
                        {reviews.length} items
                    </span>
                </div>

                <div className="min-w-0 overflow-x-auto">
                    <div className="min-w-[920px]">
                        <div className="flex h-8 items-center border-b border-gray-200 pr-8 text-xs font-medium text-gray-500">
                            <div className="w-8 shrink-0" />
                            <div className="w-60 shrink-0 pl-2 pr-4">Matter</div>
                            <div className="min-w-0 flex-1 pr-4">Issue</div>
                            <div className="w-40 shrink-0">Tag</div>
                            <div className="w-24 shrink-0">Risk</div>
                            <div className="w-8 shrink-0" />
                        </div>
                    {reviews.map((item) => (
                        <Link
                            key={item.id}
                            href="/aletheia/matters/matter-demo-legal-001"
                                className="group flex min-h-16 items-center border-b border-gray-50 pr-8 transition-colors hover:bg-gray-50"
                        >
                                <div className="flex w-8 shrink-0 justify-center">
                                    <ClipboardCheck className="h-3.5 w-3.5 text-gray-300 group-hover:text-gray-500" />
                                </div>
                                <div className="w-60 shrink-0 pl-2 pr-4">
                                    <p className="truncate text-sm text-gray-800">
                                        {item.matterTitle}
                                    </p>
                                    <p className="mt-0.5 truncate text-xs text-gray-400">
                                        {item.status}
                                    </p>
                                </div>
                                <div className="min-w-0 flex-1 pr-4 py-3">
                                    <p className="truncate text-sm text-gray-800">{item.title}</p>
                                    <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-gray-500">{item.comment}</p>
                                </div>
                                <div className="w-40 shrink-0">
                                    <Badge variant="outline" className="rounded-full border-gray-200 bg-white px-2 py-0 text-[11px] text-gray-600">
                                        {titleize(item.tag)}
                                    </Badge>
                                </div>
                                <div className="w-24 shrink-0">
                                    <Badge variant="outline" className={cn("rounded-full px-2 py-0 text-[11px]", riskClass(item.riskLevel))}>
                                    {item.riskLevel}
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
