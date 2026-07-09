import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { canExportFinal } from "@/aletheia/agentops/gates";
import type { GateResult, GateStatus } from "@/aletheia/agentops/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type GateProvenanceView = {
  gate_id: string;
  source_record_refs: GateSourceRefView[];
  unresolved_source_requirements: string[];
};

type GateSourceRefView = {
  type: string;
  id: string;
  role: string;
  document_id?: string | null;
  source_chunk_id?: string | null;
  quote_start?: number | null;
  quote_end?: number | null;
  claim_id?: string | null;
};

const statusIcon = {
  passed: CheckCircle2,
  warning: AlertTriangle,
  failed: XCircle,
  skipped: CircleDashed,
} satisfies Record<GateStatus, typeof CheckCircle2>;

function titleize(value: string) {
  return value.replaceAll("_", " ");
}

function sourceLabel(ref: GateSourceRefView) {
  return `${titleize(ref.type)} ${ref.id}`;
}

function sourceMeta(ref: GateSourceRefView) {
  return [
    ref.document_id ? `doc ${ref.document_id}` : null,
    ref.source_chunk_id ? `chunk ${ref.source_chunk_id}` : null,
    ref.claim_id ? `claim ${ref.claim_id}` : null,
    typeof ref.quote_start === "number" && typeof ref.quote_end === "number"
      ? `quote ${ref.quote_start}-${ref.quote_end}`
      : null,
  ].filter(Boolean);
}

function statusClass(status: GateStatus) {
  if (status === "passed") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "warning") return "border-amber-200 bg-amber-50 text-amber-800";
  if (status === "failed") return "border-red-200 bg-red-50 text-red-700";
  return "border-gray-200 bg-gray-50 text-gray-600";
}

export function GateChecklist({
  gateResults,
  gateProvenance = [],
  className,
}: {
  gateResults: GateResult[];
  gateProvenance?: GateProvenanceView[];
  className?: string;
}) {
  const finalAllowed = canExportFinal(gateResults);
  const provenanceByGateId = new Map(
    gateProvenance.map((item) => [item.gate_id, item] as const),
  );

  return (
    <section
      data-testid="agentops-gate-checklist"
      className={cn("rounded-lg border border-[#e5e7eb] bg-white p-4", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-[#111827]" />
          <h2 className="font-semibold">Trust Gates</h2>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "rounded-md",
            finalAllowed
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-700",
          )}
        >
          {finalAllowed ? "Final export ready" : "Final export blocked"}
        </Badge>
      </div>

      <div className="mt-3 space-y-2">
        {gateResults.map((gate) => {
          const Icon = statusIcon[gate.status];
          const provenance = provenanceByGateId.get(gate.id);
          const sourceCount = provenance?.source_record_refs.length ?? 0;
          const unresolvedCount =
            provenance?.unresolved_source_requirements.length ?? 0;
          const hasProvenanceDetail = sourceCount > 0 || unresolvedCount > 0;
          return (
            <div
              key={gate.id}
              className="rounded-md border border-[#edf0f2] bg-[#fbfcfc] p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[#374151]" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[#111827]">
                      {titleize(gate.gate_type)}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-[#6b7280]">
                      {gate.reason}
                    </p>
                  </div>
                </div>
                <Badge
                  variant="outline"
                  className={cn("rounded-md", statusClass(gate.status))}
                >
                  {titleize(gate.status)}
                </Badge>
              </div>
              {gate.required_action && (
                <p className="mt-2 text-xs leading-5 text-[#374151]">
                  {gate.required_action}
                </p>
              )}
              {provenance && (
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  <span className="rounded-md border border-[#e5e7eb] bg-white px-2 py-1 text-[#374151]">
                    {sourceCount} persisted source
                    {sourceCount === 1 ? "" : "s"}
                  </span>
                  {unresolvedCount > 0 && (
                    <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-amber-800">
                      {unresolvedCount} source gap
                      {unresolvedCount === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
              )}
              {provenance && hasProvenanceDetail && (
                <details className="mt-2 rounded-md border border-[#e5e7eb] bg-white px-3 py-2 text-xs text-[#374151]">
                  <summary className="cursor-pointer font-medium text-[#111827]">
                    Source detail
                  </summary>
                  {sourceCount > 0 && (
                    <ul className="mt-2 space-y-2">
                      {provenance.source_record_refs.map((ref) => {
                        const meta = sourceMeta(ref);
                        return (
                          <li
                            key={`${gate.id}-${ref.type}-${ref.id}-${ref.role}`}
                            className="min-w-0"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="break-all font-medium">
                                {sourceLabel(ref)}
                              </span>
                              <span className="rounded border border-[#e5e7eb] bg-[#f9fafb] px-1.5 py-0.5 text-[#6b7280]">
                                {titleize(ref.role)}
                              </span>
                            </div>
                            {meta.length > 0 && (
                              <div className="mt-1 flex flex-wrap gap-1.5">
                                {meta.map((item) => (
                                  <span
                                    key={`${gate.id}-${ref.id}-${item}`}
                                    className="rounded border border-[#e5e7eb] bg-[#f9fafb] px-1.5 py-0.5 text-[#6b7280]"
                                  >
                                    {item}
                                  </span>
                                ))}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {unresolvedCount > 0 && (
                    <ul className="mt-2 list-disc space-y-1 pl-4 text-amber-800">
                      {provenance.unresolved_source_requirements.map((requirement) => (
                        <li key={`${gate.id}-${requirement}`}>{requirement}</li>
                      ))}
                    </ul>
                  )}
                </details>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
