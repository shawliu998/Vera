import { History } from "lucide-react";
import { AletheiaShell } from "@/aletheia/AletheiaShell";
import { getAuditQueue, getWorkProductSummaries } from "@/aletheia/workflow";
import { Badge } from "@/components/ui/badge";

function titleize(value: string) {
    return value.replaceAll("_", " ");
}

function formatAuditTimestamp(value: string) {
    return new Intl.DateTimeFormat("en-US", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "Asia/Shanghai",
    }).format(new Date(value));
}

export default function AletheiaAuditPage() {
    const events = getAuditQueue();
    const workProducts = getWorkProductSummaries();

    return (
        <AletheiaShell>
            <section className="flex min-h-full flex-col bg-white">
                <div className="px-8 py-4">
                    <h1 className="font-serif text-2xl font-medium text-gray-900">
                        Audit Trail
                    </h1>
                    <p className="mt-1 text-xs text-gray-400">
                        Material workflow events for inspection, review, and export.
                    </p>
                </div>

                <div className="flex h-10 items-center gap-5 border-b border-t border-gray-100 px-8 text-sm">
                    <span className="font-medium text-gray-900">Matter Events</span>
                    <span className="ml-auto text-xs text-gray-400">
                        {events.length} events
                    </span>
                </div>

                <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_340px]">
                    <section className="overflow-y-auto px-8 py-5">
                        <div className="max-w-3xl space-y-0">
                            {events.map((event) => (
                                <div key={event.id} className="relative border-l border-gray-200 pb-6 pl-5 last:pb-0">
                                    <div className="absolute -left-1 top-1.5 h-2 w-2 rounded-full bg-gray-900" />
                                    <div className="flex flex-wrap items-center gap-2">
                                        <p className="text-sm font-medium text-gray-900">
                                            {titleize(event.action)}
                                        </p>
                                        <Badge variant="outline" className="rounded-full border-gray-200 bg-white px-2 py-0 text-[11px] text-gray-600">
                                            {event.actor}
                                        </Badge>
                                    </div>
                                    <p className="mt-1 text-sm text-gray-500">{event.matterTitle}</p>
                                    <p className="mt-1 text-xs text-gray-400">
                                        {formatAuditTimestamp(event.timestamp)} · {event.workflowVersion ?? "manual"}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </section>

                    <aside className="border-l border-gray-100 px-5 py-5">
                        <div className="flex items-center gap-2">
                            <History className="h-4 w-4 text-gray-400" />
                            <h2 className="text-sm font-medium text-gray-900">Work Products</h2>
                        </div>
                        <div className="mt-4 space-y-4">
                            {workProducts.map((item) => (
                                <div key={item.id} className="border-b border-gray-100 pb-4 last:border-b-0">
                                    <div className="flex items-center justify-between gap-2">
                                        <p className="text-sm font-medium text-gray-900">{item.kind}</p>
                                        <Badge variant="outline" className="rounded-full border-gray-200 bg-white px-2 py-0 text-[11px] text-gray-600">
                                            {titleize(item.status)}
                                        </Badge>
                                    </div>
                                    <p className="mt-1 text-sm text-gray-500">{item.title}</p>
                                    <p className="mt-1 text-xs text-gray-400">{item.count} structured records</p>
                                </div>
                            ))}
                        </div>
                    </aside>
                </div>
            </section>
        </AletheiaShell>
    );
}
