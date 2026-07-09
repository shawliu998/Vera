import { AlertCircle, CheckCircle2, FileText, GitBranch, HelpCircle } from "lucide-react";

import type { BigAtReferenceResolution, ReferencePreview } from "@/aletheia/agentops";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type ReferencePreviewProps = {
  preview?: ReferencePreview;
  resolution?: BigAtReferenceResolution;
  className?: string;
};

function statusIcon(status: BigAtReferenceResolution["status"] | "preview") {
  if (status === "resolved" || status === "preview") {
    return <CheckCircle2 className="size-4 text-emerald-600" aria-hidden="true" />;
  }

  if (status === "ambiguous") {
    return <HelpCircle className="size-4 text-amber-600" aria-hidden="true" />;
  }

  return <AlertCircle className="size-4 text-red-600" aria-hidden="true" />;
}

function statusTone(status: BigAtReferenceResolution["status"] | "preview") {
  if (status === "ambiguous") {
    return "border-amber-200 bg-amber-50/70";
  }
  if (status === "missing") {
    return "border-red-200 bg-red-50/70";
  }
  return "border-slate-200 bg-white";
}

function statusLabel(status: BigAtReferenceResolution["status"] | "preview") {
  if (status === "preview") return "preview";
  return status;
}

function typeIcon(type?: ReferencePreview["type"]) {
  if (type === "Run" || type === "Gate") {
    return <GitBranch className="size-4 text-slate-500" aria-hidden="true" />;
  }

  return <FileText className="size-4 text-slate-500" aria-hidden="true" />;
}

export function ReferencePreviewCard({
  preview,
  resolution,
  className,
}: ReferencePreviewProps) {
  const firstMatch = preview ?? resolution?.matches[0];
  const status = resolution?.status ?? "preview";
  const type = firstMatch?.type ?? resolution?.reference.type;
  const label = firstMatch?.label ?? resolution?.reference.raw ?? "Unresolved reference";
  const description = firstMatch?.description ?? resolution?.message;
  const candidateLabels =
    resolution?.status === "ambiguous"
      ? resolution.matches.map((match) => match.label).slice(0, 3)
      : [];
  const metadata = firstMatch?.metadata
    ? Object.entries(firstMatch.metadata)
        .filter((entry): entry is [string, string | number | boolean] =>
          ["string", "number", "boolean"].includes(typeof entry[1]),
        )
        .slice(0, 3)
    : [];

  return (
    <article
      className={cn(
        "grid gap-2 rounded-md border p-3 text-sm shadow-sm",
        statusTone(status),
        className,
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {typeIcon(type)}
          <div className="min-w-0">
            <div className="truncate font-medium text-slate-950">{label}</div>
            {description ? (
              <div className="line-clamp-2 text-xs text-slate-600">{description}</div>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {type ? <Badge variant="outline">{type}</Badge> : null}
          <Badge
            variant="outline"
            className="rounded-md bg-white px-2 py-1 text-[11px] capitalize"
          >
            {statusLabel(status)}
          </Badge>
          {statusIcon(status)}
        </div>
      </div>
      {resolution?.status === "ambiguous" && resolution.matches.length > 1 ? (
        <div className="rounded-md border border-amber-200 bg-white px-3 py-2 text-xs text-amber-800">
          <div className="font-medium">
            {resolution.matches.length} possible matches. Use a more specific selector.
          </div>
          {candidateLabels.length > 0 ? (
            <div className="mt-1 text-amber-700">
              Candidates: {candidateLabels.join("; ")}
            </div>
          ) : null}
        </div>
      ) : null}
      {resolution?.status === "missing" ? (
        <div className="rounded-md border border-red-200 bg-white px-3 py-2 text-xs text-red-700">
          {resolution.message ?? "No local matter object matched this reference."}
        </div>
      ) : null}
      {metadata.length > 0 ? (
        <dl className="flex flex-wrap gap-2 text-[11px] text-slate-600">
          {metadata.map(([key, value]) => (
            <div
              key={key}
              className="rounded-md border border-slate-200 bg-white px-2 py-1"
            >
              <dt className="inline font-medium">{key}: </dt>
              <dd className="inline">{String(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </article>
  );
}
